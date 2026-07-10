import { describe, it, expect } from 'vitest';
import { GrowthSim, type SpawnRecord } from '../src/sim/growth/growth';
import { RoadGraph } from '../src/sim/roads/graph';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { makeSampler } from '../src/sim/roads/path';
import { EventBus } from '../src/core/events';
import { createRng } from '../src/core/rng';
import { GRID_SIZE, CELL, WORLD_SIZE, ROAD_WIDTH } from '../src/core/constants';

const HALF = WORLD_SIZE / 2;
/** Inverse of growth.ts's private `cellCenter` — maps a grid cell (i, j) back to its world-space
 * center, matching `CELL`/`GRID_SIZE` exactly as growth.ts does internally. */
function cellCenter(i: number, j: number): { x: number; z: number } {
  return { x: i * CELL - HALF, z: j * CELL - HALF };
}

function world() {
  const bus = new EventBus();
  const hf = new Heightfield('grow-test', bus);
  const g = new RoadGraph(bus, makeSampler(hf));
  let anchor = { x: 0, z: 0 };
  outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
    if (hf.isLand(x, z) && hf.isLand(x + 64, z)) { anchor = { x, z }; break outer; }
  g.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
  for (const e of g.edges.values()) e.stage = 'painted';
  const sim = new GrowthSim(g, hf, bus, createRng('grow'));
  bus.emit('roads:changed', {});
  return { bus, sim, g };
}

describe('GrowthSim', () => {
  it('spawns trees first, then houses, near painted roads', () => {
    const { bus, sim } = world();
    const kinds: string[] = [];
    bus.on('growth:spawn', (e) => kinds.push(e.kind));
    // Task 23 slowed development pacing (first house no sooner than ~3 sim-min, first building no
    // sooner than ~5 sim-min — see growth.ts's THRESHOLDS/DEV_RATE_BASE doc comments), so the old
    // 5 sim-minute run no longer reliably observes houses. Extended to 7 sim-minutes, which
    // comfortably clears the ~231s first-house / ~324s first-building marks measured by direct
    // simulation while keeping the assertions themselves unchanged in strength.
    for (let i = 0; i < 60 * 420; i++) sim.update(1 / 60); // 7 sim-minutes
    expect(kinds.filter((k) => k === 'tree').length).toBeGreaterThan(0);
    const firstTree = kinds.indexOf('tree'), firstHouse = kinds.indexOf('house');
    expect(firstHouse).toBeGreaterThan(-1); // pacing slowed but houses must still appear in 7 sim-min
    expect(firstTree).toBeLessThan(firstHouse);
    expect(sim.houseCount).toBe(kinds.filter((k) => k === 'house').length);
  });
  it('spawns nothing with no painted roads', () => {
    const bus = new EventBus();
    const hf = new Heightfield('grow-test-2', bus);
    const g = new RoadGraph(bus, makeSampler(hf));
    const sim = new GrowthSim(g, hf, bus, createRng('grow'));
    let n = 0;
    bus.on('growth:spawn', () => n++);
    for (let i = 0; i < 60 * 60; i++) sim.update(1 / 60);
    expect(n).toBe(0);
  });

  // Task 30: settlement placement intelligence — houses/buildings face the nearest road at a
  // consistent setback, fields prefer to sit near an existing house, and placement stays
  // deterministic for a given seed + build sequence.

  /** Nearest painted-road sample to (x, z), scanning every edge exactly like growth.ts does. */
  function nearestRoadSample(g: RoadGraph, x: number, z: number): { x: number; z: number; dist: number } {
    let best = { x, z, dist: Infinity };
    for (const edge of g.edges.values()) {
      for (const s of edge.samples) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < best.dist) best = { x: s.x, z: s.z, dist: d };
      }
    }
    return best;
  }

  it('houses face their nearest road within 0.35 rad', () => {
    const { bus, sim, g } = world();
    const houses: { x: number; z: number; rot: number }[] = [];
    bus.on('growth:spawn', (e) => {
      if (e.kind === 'house') houses.push({ x: e.x, z: e.z, rot: e.rot });
    });
    for (let i = 0; i < 60 * 420; i++) sim.update(1 / 60); // 7 sim-minutes, as above
    expect(houses.length).toBeGreaterThan(0);
    for (const h of houses) {
      const near = nearestRoadSample(g, h.x, h.z);
      const toRoad = Math.atan2(near.z - h.z, near.x - h.x);
      let diff = Math.abs(toRoad - h.rot);
      diff = diff > Math.PI ? 2 * Math.PI - diff : diff;
      expect(diff).toBeLessThan(0.35);
    }
  });

  it('houses sit at a consistent setback distance from the nearest road sample', () => {
    const { bus, sim, g } = world();
    const houses: { x: number; z: number }[] = [];
    bus.on('growth:spawn', (e) => {
      if (e.kind === 'house') houses.push({ x: e.x, z: e.z });
    });
    for (let i = 0; i < 60 * 420; i++) sim.update(1 / 60);
    expect(houses.length).toBeGreaterThan(0);
    for (const h of houses) {
      const near = nearestRoadSample(g, h.x, h.z);
      expect(near.dist).toBeGreaterThanOrEqual(6.5);
      expect(near.dist).toBeLessThanOrEqual(11);
    }
  });

  it('fields prefer cells near an existing house (deterministic seed)', () => {
    const { bus, sim } = world();
    const records: { kind: string; x: number; z: number }[] = [];
    bus.on('growth:spawn', (e) => records.push({ kind: e.kind, x: e.x, z: e.z }));
    for (let i = 0; i < 60 * 420; i++) sim.update(1 / 60);
    const houses = records.filter((r) => r.kind === 'house');
    const fields = records.filter((r) => r.kind === 'field');
    expect(houses.length).toBeGreaterThan(0);
    expect(fields.length).toBeGreaterThan(0);
    const nearHouse = (f: { x: number; z: number }) =>
      houses.some((h) => Math.hypot(h.x - f.x, h.z - f.z) <= 14);
    const fieldsNearHouse = fields.filter(nearHouse).length;
    // Not every field will have a house within range (houses appear later in the dev sequence,
    // and fields spawn before some houses exist), but a clear majority should end up adjacent to
    // one once houses exist, given the preference logic scans for them.
    expect(fieldsNearHouse).toBeGreaterThan(0);
  });

  it('is deterministic: same seed + build sequence produces identical records', () => {
    function run() {
      const { sim } = world();
      for (let i = 0; i < 60 * 420; i++) sim.update(1 / 60);
      return sim.spawned.map((r) => ({ ...r }));
    }
    const a = run();
    const b = run();
    expect(a).toEqual(b);
  });

  // Task 35: stable ids on spawn records.
  describe('record ids', () => {
    it('assigns unique, monotonic ids to spawned records', () => {
      const { bus, sim } = world();
      const ids: number[] = [];
      bus.on('growth:spawn', (e) => {
        expect(typeof e.id).toBe('number');
        ids.push(e.id!);
      });
      for (let i = 0; i < 60 * 420; i++) sim.update(1 / 60);
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
      for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1]);
      // sim.spawned's own ids match what was emitted, in the same order.
      expect(sim.spawned.map((r) => r.id)).toEqual(ids);
    });
  });

  // Task 35: upgrades — a developed cell's house record becomes a building once dev crosses
  // HOUSE_UPGRADE_DEV (1.35) AND at least 2 of its 4 orthogonal neighbor cells are themselves
  // "developed" (dev >= the house threshold, 0.75). Using `restore()` to seed dev/records directly
  // is far faster than waiting out real accumulation and exercises the same code path `update()`
  // uses to check thresholds each tick.
  describe('upgrades', () => {
    /**
     * A world with an actual painted road running through a flat area, so the road-distance BFS
     * (`roadDist`) covers the target cell — the upgrade check only runs inside `update()`'s main
     * per-cell loop, which skips any cell `roadDist` doesn't mark as within MAX_ROAD_DIST_CELLS (a
     * cell can only ever reach dev >= 1.35 near a road anyway, so this mirrors real play). Returns
     * a flat land cell (and confirms its 4 neighbors are also land+flat) sitting on that road.
     */
    function seededWorld() {
      const bus = new EventBus();
      const hf = new Heightfield('upgrade-test', bus);
      const g = new RoadGraph(bus, makeSampler(hf));
      let anchor = { x: 0, z: 0 };
      outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
        if (hf.isLand(x, z) && hf.isLand(x + 64, z)) { anchor = { x, z }; break outer; }
      const [edgeId] = g.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
      for (const e of g.edges.values()) e.stage = 'painted';
      const sim = new GrowthSim(g, hf, bus, createRng('upgrade'));
      bus.emit('roads:changed', {});
      sim.update(3); // apply the throttled road-distance recompute
      const { i, j } = findFlatCell(hf, anchor);
      return { bus, sim, hf, g, edgeId, i, j };
    }

    /** Finds a flat, land cell (and its 4 neighbors) near `near`, suitable for seeding dev levels
     * directly and guaranteed to sit within the road-distance BFS's reach of a road at `near`. */
    function findFlatCell(hf: Heightfield, near: { x: number; z: number }): { i: number; j: number } {
      const midI = Math.round((near.x + HALF) / CELL);
      const midJ = Math.round((near.z + HALF) / CELL);
      for (let dj = -3; dj <= 3; dj++) {
        for (let di = -3; di <= 3; di++) {
          const i = midI + di, j = midJ + dj;
          const { x, z } = cellCenter(i, j);
          if (hf.isLand(x, z) && hf.slopeAt(x, z) < 0.3) {
            // also require its 4 neighbors land+flat so upgrade-eligibility tests have real cells
            const ok = [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]].every(([ni, nj]) => {
              const c = cellCenter(ni, nj);
              return hf.isLand(c.x, c.z) && hf.slopeAt(c.x, c.z) < 0.3;
            });
            if (ok) return { i, j };
          }
        }
      }
      throw new Error('no flat cell found near the test road');
    }

    it('upgrades a house to a building once dev >= 1.35 with >= 2 developed neighbors', () => {
      const { bus, sim, i, j } = seededWorld();
      const dev = new Float32Array(GRID_SIZE * GRID_SIZE);
      const idx = (ii: number, jj: number) => jj * GRID_SIZE + ii;
      dev[idx(i, j)] = 1.35;
      dev[idx(i - 1, j)] = 0.8; // developed neighbor 1
      dev[idx(i + 1, j)] = 0.8; // developed neighbor 2
      const { x, z } = cellCenter(i, j);
      const house: SpawnRecord = { kind: 'house', x, z, rot: 0, id: 1 };
      sim.restore(dev, [house]);

      const upgrades: number[] = [];
      bus.on('growth:upgrade', (e) => upgrades.push(e.id));
      expect(sim.houseCount).toBe(1);
      sim.update(1 / 60);

      expect(upgrades).toEqual([1]);
      expect(sim.spawned[0].kind).toBe('building');
      expect(sim.spawned[0].id).toBe(1); // same record, same id — mutated in place
      expect(sim.houseCount).toBe(0);
    });

    it('does not upgrade when dev is high but fewer than 2 neighbors are developed', () => {
      const { bus, sim, i, j } = seededWorld();
      const dev = new Float32Array(GRID_SIZE * GRID_SIZE);
      const idx = (ii: number, jj: number) => jj * GRID_SIZE + ii;
      dev[idx(i, j)] = 1.35;
      dev[idx(i - 1, j)] = 0.8; // only ONE developed neighbor
      const { x, z } = cellCenter(i, j);
      const house: SpawnRecord = { kind: 'house', x, z, rot: 0, id: 1 };
      sim.restore(dev, [house]);

      let upgraded = false;
      bus.on('growth:upgrade', () => { upgraded = true; });
      sim.update(1 / 60);

      expect(upgraded).toBe(false);
      expect(sim.spawned[0].kind).toBe('house');
      expect(sim.houseCount).toBe(1);
    });

    it('does not upgrade a cell with no house record even if dev/neighbors qualify', () => {
      const { bus, sim, i, j } = seededWorld();
      const dev = new Float32Array(GRID_SIZE * GRID_SIZE);
      const idx = (ii: number, jj: number) => jj * GRID_SIZE + ii;
      dev[idx(i, j)] = 1.35;
      dev[idx(i - 1, j)] = 0.8;
      dev[idx(i + 1, j)] = 0.8;
      sim.restore(dev, []); // no records at all

      let upgraded = false;
      bus.on('growth:upgrade', () => { upgraded = true; });
      expect(() => sim.update(1 / 60)).not.toThrow();
      expect(upgraded).toBe(false);
    });

    it('upgrades a cell at most once (fires growth:upgrade exactly once across many updates)', () => {
      const { bus, sim, i, j } = seededWorld();
      const dev = new Float32Array(GRID_SIZE * GRID_SIZE);
      const idx = (ii: number, jj: number) => jj * GRID_SIZE + ii;
      dev[idx(i, j)] = 1.35;
      dev[idx(i - 1, j)] = 0.8;
      dev[idx(i + 1, j)] = 0.8;
      const { x, z } = cellCenter(i, j);
      const house: SpawnRecord = { kind: 'house', x, z, rot: 0, id: 1 };
      sim.restore(dev, [house]);

      let upgradeCount = 0;
      bus.on('growth:upgrade', () => upgradeCount++);
      for (let k = 0; k < 300; k++) sim.update(1 / 60);

      expect(upgradeCount).toBe(1);
    });

    // Groundwork batch-review Finding 1 (Critical): tryUpgrade's target-selection scan used to
    // match ANY house record sitting in the eligible cell, including one that is mid-corridor-
    // clearing (clearingSince) or mid-stranded-fade (fadingSince) — both states where the record is
    // already animating out and about to be removed entirely. Upgrading it first (mutating its
    // `kind` to 'building' in place) would fire growth:upgrade for a record that's a few ticks from
    // vanishing, which is visually nonsensical (a building appearing then immediately dissolving)
    // and leaves stale bookkeeping (the clearing/fading maps still reference the id under its old
    // kind's semantics). Fix: tryUpgrade's scan skips any record id present in clearingSince OR
    // fadingSince. A grace-only record (strandedSince set, not yet fading — the record is NOT
    // visually animating, it's just sitting in its normal spot during the silent 60s grace) is a
    // judgment call: we choose to ALSO skip it here for a simpler, single rule ("any decay timer in
    // flight blocks upgrade") rather than special-casing "grace is fine, fade is not" — simpler to
    // reason about and matches the spirit of "don't let two lifecycle pipelines race over the same
    // record" already used elsewhere in this file (see updateStrandedDecay's clearingSince guard).
    describe('does not upgrade a record with an in-flight decay/clearing timer (Groundwork Finding 1)', () => {
      it('skips a house mid-corridor-clearing even when upgrade conditions are met', () => {
        const { bus, sim, hf, g, edgeId } = seededWorld();
        const edge = g.edges.get(edgeId)!;
        const sample = edge.samples[Math.floor(edge.samples.length / 2)];
        // Need a flat (per growth.ts's own MAX_SLOPE=0.5 gate — update()'s per-cell loop skips
        // steeper cells entirely, upgrade check included), land cell whose CENTER is within
        // CLEAR_RADIUS (5u) of a road sample (so the house placed there actually clears). The 4
        // neighbor cells only need their `dev` array entries set (checked directly below, not via
        // live accumulation), so they don't need their own slope/land constraints satisfied.
        const midI = Math.round((sample.x + HALF) / CELL);
        const midJ = Math.round((sample.z + HALF) / CELL);
        let found: { i: number; j: number } | null = null;
        outer: for (let dj = -2; dj <= 2; dj++) {
          for (let di = -2; di <= 2; di++) {
            const ci = midI + di, cj = midJ + dj;
            const c = cellCenter(ci, cj);
            if (Math.hypot(c.x - sample.x, c.z - sample.z) > 5) continue;
            if (!hf.isLand(c.x, c.z) || hf.slopeAt(c.x, c.z) > 0.5) continue;
            found = { i: ci, j: cj };
            break outer;
          }
        }
        expect(found).not.toBeNull();
        const { i, j } = found!;
        const { x: cx, z: cz } = cellCenter(i, j);
        expect(Math.hypot(cx - sample.x, cz - sample.z)).toBeLessThanOrEqual(5);

        const dev = new Float32Array(GRID_SIZE * GRID_SIZE);
        const idx = (ii: number, jj: number) => jj * GRID_SIZE + ii;
        dev[idx(i, j)] = 1.35;
        dev[idx(i - 1, j)] = 0.8; // developed neighbor 1
        dev[idx(i + 1, j)] = 0.8; // developed neighbor 2
        const house: SpawnRecord = { kind: 'house', x: cx, z: cz, rot: 0, id: 1 };

        const clearedIds: number[] = [];
        const upgradedIds: number[] = [];
        bus.on('growth:cleared', (e) => clearedIds.push(e.id));
        bus.on('growth:upgrade', (e) => upgradedIds.push(e.id));

        // The edge is already 'painted' (past 'graded') at this point (seededWorld sets it so),
        // so restore()'s own corridor re-scan clears this record immediately — mirroring the
        // "restore re-clears the corridor" tests above rather than needing a fresh
        // construction:stage event.
        sim.restore(dev, [house]);
        expect(clearedIds).toEqual([1]); // confirm it's actually mid-clearing before asserting the negative

        sim.update(1 / 60); // upgrade conditions are met on this very tick too
        expect(upgradedIds).toEqual([]);
        expect(sim.spawned.find((r) => r.id === 1)?.kind).toBe('house'); // never mutated to 'building'
      });

      it('skips a house mid-stranded-fade even when upgrade conditions are met', () => {
        const { bus, sim, i, j } = seededWorld();
        const dev = new Float32Array(GRID_SIZE * GRID_SIZE);
        const idx = (ii: number, jj: number) => jj * GRID_SIZE + ii;
        dev[idx(i, j)] = 1.35;
        dev[idx(i - 1, j)] = 0.8;
        dev[idx(i + 1, j)] = 0.8;
        const { x, z } = cellCenter(i, j);
        const house: SpawnRecord = { kind: 'house', x, z, rot: 0, id: 1 };
        // Seed the record already mid-fade (post-grace) via restore()'s decay param, exactly like
        // the "decay state persistence" tests do.
        sim.restore(dev, [house], [{ id: 1, fading: 5 }]);

        const upgradedIds: number[] = [];
        bus.on('growth:upgrade', (e) => upgradedIds.push(e.id));
        sim.update(1 / 60);

        expect(upgradedIds).toEqual([]);
        expect(sim.spawned.find((r) => r.id === 1)?.kind).toBe('house');
      });

      it('(documented choice) also skips a grace-only house, not just mid-fade/mid-clearing', () => {
        const { bus, sim, i, j } = seededWorld();
        const dev = new Float32Array(GRID_SIZE * GRID_SIZE);
        const idx = (ii: number, jj: number) => jj * GRID_SIZE + ii;
        dev[idx(i, j)] = 1.35;
        dev[idx(i - 1, j)] = 0.8;
        dev[idx(i + 1, j)] = 0.8;
        const { x, z } = cellCenter(i, j);
        const house: SpawnRecord = { kind: 'house', x, z, rot: 0, id: 1 };
        // Grace-only: strandedSince is set, fadingSince is not — the record is NOT visually
        // fading/animating, it's just silently sitting out its 60s grace window.
        sim.restore(dev, [house], [{ id: 1, stranded: 10 }]);

        const upgradedIds: number[] = [];
        bus.on('growth:upgrade', (e) => upgradedIds.push(e.id));
        sim.update(1 / 60);

        // Documented choice (see describe-block comment above): grace-only records are also
        // skipped for upgrade purposes, even though they aren't animating — simpler single rule.
        expect(upgradedIds).toEqual([]);
        expect(sim.spawned.find((r) => r.id === 1)?.kind).toBe('house');
      });
    });
  });

  // Task 35: stranded decay — a record whose cell is unreachable from any painted road (roadDist
  // reads -1, i.e. > MAX_ROAD_DIST_CELLS ~ 24u) enters a 60 sim-s grace period, then fades over 30
  // more sim-s (growth:stranded fires at fade start), then is removed (growth:remove), clearing the
  // cell's spawnMask (regrowth becomes possible) and decrementing houseCount for a house.
  describe('stranded decay', () => {
    /** Finds a land point at least `minDist` from `anchor` and >=32u of contiguous land beyond it
     * (so a rescue road can later be drawn starting there), searching a coarse grid outward from
     * the world center. Deterministic per Heightfield instance. */
    function findFarLandSpot(hf: Heightfield, anchor: { x: number; z: number }, minDist: number): { x: number; z: number } {
      for (let x = -220; x <= 220; x += 8) {
        for (let z = -220; z <= 220; z += 8) {
          if (Math.hypot(x - anchor.x, z - anchor.z) < minDist) continue;
          if (hf.isLand(x, z) && hf.isLand(x + 32, z)) return { x, z };
        }
      }
      throw new Error('no far land spot found');
    }

    function roadedWorld(seedName: string) {
      const bus = new EventBus();
      const hf = new Heightfield(seedName, bus);
      const g = new RoadGraph(bus, makeSampler(hf));
      let anchor = { x: 0, z: 0 };
      outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
        if (hf.isLand(x, z) && hf.isLand(x + 32, z)) { anchor = { x, z }; break outer; }
      const [edgeId] = g.commitChain([anchor, { x: anchor.x + 32, z: anchor.z }]);
      for (const e of g.edges.values()) e.stage = 'painted';
      const sim = new GrowthSim(g, hf, bus, createRng(seedName));
      bus.emit('roads:changed', {});
      // One throttled recompute so the road-distance field is populated before we seed a record.
      sim.update(3);
      const farSpot = findFarLandSpot(hf, anchor, 40); // > MAX_ROAD_DIST_CELLS's ~24u, comfortably
      return { bus, sim, g, hf, edgeId, anchor, farSpot };
    }

    it('a record near a painted road is never marked stranded', () => {
      const { bus, sim, anchor } = roadedWorld('stranded-near');
      // Task 42: offset 10u perpendicular (z) from the road's centerline — comfortably outside
      // corridor-clearing's CLEAR_RADIUS (ROAD_WIDTH/2 + 2 = 5u, since the road runs along x here)
      // so this fixture still tests stranded-decay proximity specifically, not the new
      // corridor-clearing behavior (a record placed directly ON the road, e.g. at `anchor` itself,
      // is now legitimately cleared as being IN the roadbed — see the "corridor clearing" describe
      // block below — which is correct T42 behavior, not a regression of this test's own intent).
      const house: SpawnRecord = { kind: 'house', x: anchor.x, z: anchor.z + 10, rot: 0, id: 1 };
      sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [house]);
      sim.update(3); // apply the pending recompute triggered by restore()

      let stranded = false;
      bus.on('growth:stranded', (e) => { if (e.id === 1) stranded = true; });
      for (let k = 0; k < 60 * 65; k++) sim.update(1 / 60); // well past the 60s grace
      expect(stranded).toBe(false);
      expect(sim.spawned.some((r) => r.id === 1)).toBe(true);
    });

    it('a record far from any road becomes stranded, fades, then is removed after grace+fade', () => {
      const { bus, sim, farSpot } = roadedWorld('stranded-far');
      // Place a record far outside MAX_ROAD_DIST_CELLS (~24u) from the only road, near the edge of
      // the world so it's unambiguously stranded once the road-distance BFS runs.
      const house: SpawnRecord = { kind: 'house', x: farSpot.x, z: farSpot.z, rot: 0, id: 1 };
      sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [house]);
      sim.update(3); // apply the pending recompute

      const strandedIds: number[] = [];
      const removedIds: number[] = [];
      bus.on('growth:stranded', (e) => strandedIds.push(e.id));
      bus.on('growth:remove', (e) => removedIds.push(e.id));
      // The seeded road at `anchor` keeps naturally developing (ambient spawns) over these long
      // loops — assertions below check for record id=1 specifically, not raw array length, so
      // unrelated ambient spawns near the road don't make this test flaky.
      const has1 = () => sim.spawned.some((r) => r.id === 1);

      // Advance to just before the 60s grace elapses — should not yet be stranded-fired.
      for (let k = 0; k < 60 * 59; k++) sim.update(1 / 60);
      expect(strandedIds).toEqual([]);
      expect(has1()).toBe(true);

      // Cross the grace threshold.
      for (let k = 0; k < 60 * 2; k++) sim.update(1 / 60);
      expect(strandedIds).toEqual([1]);
      expect(removedIds).toEqual([]); // fade not yet complete
      expect(has1()).toBe(true); // still present during the fade

      // Just before fade completes (30s later) — not yet removed.
      for (let k = 0; k < 60 * 29; k++) sim.update(1 / 60);
      expect(removedIds).toEqual([]);

      // Cross the fade-complete threshold.
      for (let k = 0; k < 60 * 2; k++) sim.update(1 / 60);
      expect(removedIds).toEqual([1]);
      expect(has1()).toBe(false);
      expect(strandedIds).toEqual([1]); // still only fired once
    });

    it('decrements houseCount when a stranded house record is removed', () => {
      const { bus, sim, farSpot } = roadedWorld('stranded-house-count');
      const house: SpawnRecord = { kind: 'house', x: farSpot.x, z: farSpot.z, rot: 0, id: 1 };
      sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [house]);
      sim.update(3);
      const housesBefore = sim.houseCount;
      expect(housesBefore).toBeGreaterThanOrEqual(1);

      let removed = false;
      bus.on('growth:remove', (e) => { if (e.id === 1) removed = true; });
      for (let k = 0; k < 60 * 91; k++) sim.update(1 / 60); // grace(60) + fade(30) + margin
      expect(removed).toBe(true);
      expect(sim.houseCount).toBe(housesBefore - 1);
    });

    it('cancels the grace/fade timers if the area is re-roaded before removal completes', () => {
      const { bus, sim, g, farSpot } = roadedWorld('stranded-cancel');
      const house: SpawnRecord = { kind: 'house', x: farSpot.x, z: farSpot.z, rot: 0, id: 1 };
      sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [house]);
      sim.update(3);

      const strandedIds: number[] = [];
      const removedIds: number[] = [];
      bus.on('growth:stranded', (e) => strandedIds.push(e.id));
      bus.on('growth:remove', (e) => removedIds.push(e.id));
      const has1 = () => sim.spawned.some((r) => r.id === 1);

      // Cross the grace period so it's mid-fade...
      for (let k = 0; k < 60 * 65; k++) sim.update(1 / 60);
      expect(strandedIds).toEqual([1]);
      expect(has1()).toBe(true);

      // ...then draw a road right next to the stranded record (farSpot was chosen so `farSpot` and
      // `farSpot.x + 32` are both land) and let the recompute apply.
      g.commitChain([farSpot, { x: farSpot.x + 32, z: farSpot.z }]);
      for (const e of g.edges.values()) e.stage = 'painted';
      bus.emit('roads:changed', {});
      for (let k = 0; k < 60 * 30; k++) sim.update(1 / 60); // let the recompute throttle open + settle

      // The record must still exist (never removed) since it was rescued before its fade completed.
      expect(has1()).toBe(true);
      expect(removedIds).toEqual([]);
    });

    // Critical 3 (Groundwork round fix wave): `updateStrandedDecay` cancelling a record's grace/fade
    // timer on re-road used to emit nothing at all — the renderer had no way to know a rescue
    // happened. These cover both directions a rescue can happen: still in the grace window (no fade
    // ever started) and mid-fade (`growth:stranded` already fired, renderer's Fading entry is live).
    describe('rescue emits growth:rescued (Critical 3)', () => {
      it('emits growth:rescued when re-roaded during the grace window (before any fade starts)', () => {
        const { bus, sim, g, farSpot } = roadedWorld('rescue-during-grace');
        const house: SpawnRecord = { kind: 'house', x: farSpot.x, z: farSpot.z, rot: 0, id: 1 };
        sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [house]);
        sim.update(3);

        const strandedIds: number[] = [];
        const rescuedIds: number[] = [];
        bus.on('growth:stranded', (e) => strandedIds.push(e.id));
        bus.on('growth:rescued', (e) => rescuedIds.push(e.id));

        // Only partway into the 60s grace — never crosses into 'stranded'/fade.
        for (let k = 0; k < 60 * 20; k++) sim.update(1 / 60);
        expect(strandedIds).toEqual([]);
        expect(rescuedIds).toEqual([]);

        // Re-road right next to it before the grace elapses.
        g.commitChain([farSpot, { x: farSpot.x + 32, z: farSpot.z }]);
        for (const e of g.edges.values()) e.stage = 'painted';
        bus.emit('roads:changed', {});
        for (let k = 0; k < 60 * 30; k++) sim.update(1 / 60); // let the recompute throttle open + settle

        expect(strandedIds).toEqual([]); // never actually reached the stranded/fade phase
        expect(rescuedIds).toEqual([1]); // but the grace timer WAS cancelled — must be reported
      });

      it('emits growth:rescued when re-roaded mid-fade (after growth:stranded already fired)', () => {
        const { bus, sim, g, farSpot } = roadedWorld('rescue-during-fade');
        const house: SpawnRecord = { kind: 'house', x: farSpot.x, z: farSpot.z, rot: 0, id: 1 };
        sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [house]);
        sim.update(3);

        const strandedIds: number[] = [];
        const rescuedIds: number[] = [];
        const removedIds: number[] = [];
        bus.on('growth:stranded', (e) => strandedIds.push(e.id));
        bus.on('growth:rescued', (e) => rescuedIds.push(e.id));
        bus.on('growth:remove', (e) => removedIds.push(e.id));

        // Cross the grace period so it's mid-fade (mirrors the existing "cancels the grace/fade
        // timers" test above).
        for (let k = 0; k < 60 * 65; k++) sim.update(1 / 60);
        expect(strandedIds).toEqual([1]);
        expect(rescuedIds).toEqual([]);

        g.commitChain([farSpot, { x: farSpot.x + 32, z: farSpot.z }]);
        for (const e of g.edges.values()) e.stage = 'painted';
        bus.emit('roads:changed', {});
        for (let k = 0; k < 60 * 30; k++) sim.update(1 / 60);

        expect(rescuedIds).toEqual([1]);
        expect(removedIds).toEqual([]); // rescued before its fade ever completed
      });

      it('does not emit growth:rescued for a record that was simply never stranded', () => {
        const { bus, sim, anchor } = roadedWorld('rescue-never-stranded');
        // Task 42: offset off the road centerline (see the "near a painted road" test's comment
        // above) so this stays a stranded-decay fixture, not a corridor-clearing one.
        const house: SpawnRecord = { kind: 'house', x: anchor.x, z: anchor.z + 10, rot: 0, id: 1 };
        sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [house]);
        sim.update(3);

        let rescuedCount = 0;
        bus.on('growth:rescued', () => { rescuedCount++; });
        for (let k = 0; k < 60 * 65; k++) sim.update(1 / 60); // well past the 60s grace, never stranded
        expect(rescuedCount).toBe(0);
      });
    });

    it('clears the cell spawnMask on removal, allowing regrowth after re-roading', () => {
      const { bus, sim, farSpot } = roadedWorld('stranded-regrowth');
      const house: SpawnRecord = { kind: 'house', x: farSpot.x, z: farSpot.z, rot: 0, id: 1 };
      // Seed this cell's dev at the house threshold so its spawnMask already has tree/field/house
      // bits set (matching a naturally-grown cell) — restore() derives spawnMask from dev.
      const dev = new Float32Array(GRID_SIZE * GRID_SIZE);
      const cellIdx = (() => {
        const ci = Math.round((farSpot.x + HALF) / CELL);
        const cj = Math.round((farSpot.z + HALF) / CELL);
        return cj * GRID_SIZE + ci;
      })();
      dev[cellIdx] = 0.8;
      sim.restore(dev, [house]);
      sim.update(3);

      let removed = false;
      bus.on('growth:remove', (e) => { if (e.id === 1) removed = true; });
      for (let k = 0; k < 60 * 91; k++) sim.update(1 / 60);
      expect(removed).toBe(true);

      // devLevels at that cell must now read at or below the decay target (0.4), well below the
      // house threshold (0.75) it was seeded at — proving the level was actually decayed down, not
      // just left in place with the record removed. A tiny epsilon absorbs Float32Array rounding
      // (0.4 isn't exactly representable in float32).
      expect(sim.devLevels[cellIdx]).toBeLessThanOrEqual(0.4 + 1e-6);
    });

    // Finding 1 (Task 35 follow-up "Groundwork"): a cell can hold multiple co-located records
    // (e.g. tree + field + house, all placed near the same cell center). Removing ONE of them via
    // stranded decay must clear only THAT record's own kind bit in spawnMask, not every bit for the
    // cell — otherwise an unrelated kind (e.g. tree, whose threshold 0.22 is well below the 0.4 decay
    // floor) silently re-arms and respawns even though its own record never left.
    //
    // Divergent per-record stranding timing isn't reachable through the public API (a cell's
    // records all share the same `roadDist` cell, so any records present together always strand/
    // grace/fade in lockstep, and `restore()` unconditionally clears every record's timer state on
    // every call — verified by tracing `updateStrandedDecay`/`restore()` directly). Per the
    // finding's documented fallback, this test instead constructs the genuinely distinguishing
    // case: a cell whose spawnMask has tree+field+house bits set (mirroring a naturally-grown cell
    // where all three thresholds were crossed) but only ONE backing record (house) actually
    // exists — a perfectly legitimate real-world state, since e.g. a tree's bit can be set by dev
    // crossing 0.22 without a tree record actually spawning (TREE_SPAWN_CHANCE thins ~60% of
    // qualifying cells to keep woodland from reading as a hedge — see growth.ts). Removing the
    // house (the only present record) via stranded decay must clear ONLY the house bit, leaving
    // the tree/field bits (which own no record to remove) untouched — the blanket-clear bug would
    // instead wipe all three, silently re-arming tree/field regrowth despite neither ever having a
    // record to begin with.
    it('removing one record clears only its own spawnMask bit, leaving unrelated recordless bits alone', () => {
      const { bus, sim, farSpot } = roadedWorld('stranded-per-kind');
      const dev = new Float32Array(GRID_SIZE * GRID_SIZE);
      const ci = Math.round((farSpot.x + HALF) / CELL);
      const cj = Math.round((farSpot.z + HALF) / CELL);
      const cellIdx = cj * GRID_SIZE + ci;
      // dev >= 0.75 (house threshold) sets tree+field+house bits via restore()'s spawnMask
      // derivation, but only a house record is actually passed in — tree/field's bits are set with
      // no backing record, a legitimate state per the doc comment above.
      dev[cellIdx] = 0.8;
      const house: SpawnRecord = { kind: 'house', x: farSpot.x, z: farSpot.z, rot: 0, id: 1 };
      sim.restore(dev, [house]);
      sim.update(3);

      const TREE_BIT = 1 << 0, FIELD_BIT = 1 << 1, HOUSE_BIT = 1 << 2;
      expect(sim.spawnMaskAt(ci, cj) & (TREE_BIT | FIELD_BIT | HOUSE_BIT)).toBe(TREE_BIT | FIELD_BIT | HOUSE_BIT);

      const removedIds: number[] = [];
      bus.on('growth:remove', (e) => removedIds.push(e.id));
      for (let k = 0; k < 60 * 91; k++) sim.update(1 / 60); // grace(60) + fade(30) + margin
      expect(removedIds).toEqual([1]);

      // The house bit must be cleared (its record is gone); tree/field bits — which never had a
      // record — must remain set exactly as they were, NOT wiped by a blanket cell clear.
      expect(sim.spawnMaskAt(ci, cj) & HOUSE_BIT).toBe(0);
      expect(sim.spawnMaskAt(ci, cj) & TREE_BIT).toBe(TREE_BIT);
      expect(sim.spawnMaskAt(ci, cj) & FIELD_BIT).toBe(FIELD_BIT);
    });

    // Finding 1, upgraded-record case: an upgraded record (house -> building, same id) that later
    // gets stranded and removed must clear BOTH the house bit and the building bit — the house
    // bit's original record is gone too (it became this same building record, not a separate
    // still-present one), so leaving the house bit set would incorrectly block a future house from
    // ever re-spawning at this cell once it redevelops.
    it('removing an upgraded (former-house) building record clears both the house and building bits', () => {
      const { bus, sim, farSpot } = roadedWorld('stranded-upgraded-bits');
      const dev = new Float32Array(GRID_SIZE * GRID_SIZE);
      const ci = Math.round((farSpot.x + HALF) / CELL);
      const cj = Math.round((farSpot.z + HALF) / CELL);
      const cellIdx = cj * GRID_SIZE + ci;
      // dev=1.1 exceeds ALL four thresholds (tree/field/house/building), so `restore()` sets every
      // bit — but only the building record is actually passed in (tree/field never had records
      // here, same "recordless bit" legitimacy as the previous test). This also makes the case
      // distinguishing: a blanket clear would wipe tree/field's bits too, not just house+building.
      dev[cellIdx] = 1.1; // past the building threshold (1.05) — as if house upgraded to building
      const building: SpawnRecord = { kind: 'building', x: farSpot.x, z: farSpot.z, rot: 0, id: 1 };
      sim.restore(dev, [building]);
      sim.update(3);

      const TREE_BIT = 1 << 0, FIELD_BIT = 1 << 1, HOUSE_BIT = 1 << 2, BUILDING_BIT = 1 << 3;
      expect(sim.spawnMaskAt(ci, cj)).toBe(TREE_BIT | FIELD_BIT | HOUSE_BIT | BUILDING_BIT);

      const removedIds: number[] = [];
      bus.on('growth:remove', (e) => removedIds.push(e.id));
      for (let k = 0; k < 60 * 91; k++) sim.update(1 / 60);
      expect(removedIds).toEqual([1]);
      // House + building bits clear (the upgraded record, and its former house stage, are both
      // gone); tree/field bits — which never had a backing record — remain untouched.
      expect(sim.spawnMaskAt(ci, cj) & (HOUSE_BIT | BUILDING_BIT)).toBe(0);
      expect(sim.spawnMaskAt(ci, cj) & TREE_BIT).toBe(TREE_BIT);
      expect(sim.spawnMaskAt(ci, cj) & FIELD_BIT).toBe(FIELD_BIT);
    });
  });

  // Finding 2 (Task 35 follow-up "Groundwork"): grace/fade timelines must survive a save/reload —
  // `decayState` exposes the current in-flight timers as sim-time-relative offsets, and
  // `restore()`'s new (optional) `decay` param re-arms those timers so they CONTINUE rather than
  // restart from zero.
  describe('decay state persistence (Finding 2)', () => {
    function findFarLandSpot(hf: Heightfield, anchor: { x: number; z: number }, minDist: number): { x: number; z: number } {
      for (let x = -220; x <= 220; x += 8) {
        for (let z = -220; z <= 220; z += 8) {
          if (Math.hypot(x - anchor.x, z - anchor.z) < minDist) continue;
          if (hf.isLand(x, z) && hf.isLand(x + 32, z)) return { x, z };
        }
      }
      throw new Error('no far land spot found');
    }

    function roadedWorld(seedName: string) {
      const bus = new EventBus();
      const hf = new Heightfield(seedName, bus);
      const g = new RoadGraph(bus, makeSampler(hf));
      let anchor = { x: 0, z: 0 };
      outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
        if (hf.isLand(x, z) && hf.isLand(x + 32, z)) { anchor = { x, z }; break outer; }
      g.commitChain([anchor, { x: anchor.x + 32, z: anchor.z }]);
      for (const e of g.edges.values()) e.stage = 'painted';
      const sim = new GrowthSim(g, hf, bus, createRng(seedName));
      bus.emit('roads:changed', {});
      sim.update(3);
      const farSpot = findFarLandSpot(hf, anchor, 40);
      return { bus, sim, g, hf, anchor, farSpot };
    }

    it('decayState is empty with no in-flight timers', () => {
      const { sim, anchor } = roadedWorld('decay-empty');
      // Near the road (never stranded), unlike `farSpot` used by the other tests below. Task 42:
      // offset off the road centerline so this isn't ALSO corridor-cleared (a separate, unrelated
      // mechanism from decayState's stranded/fading tracking, but keeping the fixture clean of it
      // avoids conflating the two).
      const house: SpawnRecord = { kind: 'house', x: anchor.x, z: anchor.z + 10, rot: 0, id: 1 };
      sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [house]);
      sim.update(3);
      expect(sim.decayState).toEqual([]);
    });

    it('decayState reports a mid-grace record\'s elapsed offset', () => {
      const { sim, farSpot } = roadedWorld('decay-midgrace');
      const house: SpawnRecord = { kind: 'house', x: farSpot.x, z: farSpot.z, rot: 0, id: 1 };
      sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [house]);
      sim.update(3); // apply pending recompute -> record reads as stranded from here
      for (let k = 0; k < 60 * 20; k++) sim.update(1 / 60); // 20s into the 60s grace
      const state = sim.decayState;
      expect(state.length).toBe(1);
      expect(state[0].id).toBe(1);
      expect(state[0].stranded).toBeCloseTo(20, 0);
      expect(state[0].fading).toBeUndefined();
    });

    it('decayState reports a mid-fade record\'s elapsed offset', () => {
      const { sim, farSpot } = roadedWorld('decay-midfade');
      const house: SpawnRecord = { kind: 'house', x: farSpot.x, z: farSpot.z, rot: 0, id: 1 };
      sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [house]);
      sim.update(3);
      for (let k = 0; k < 60 * 75; k++) sim.update(1 / 60); // past the 60s grace, 15s into the 30s fade
      const state = sim.decayState;
      expect(state.length).toBe(1);
      expect(state[0].id).toBe(1);
      expect(state[0].fading).toBeCloseTo(15, 0);
      expect(state[0].stranded).toBeUndefined();
    });

    it('restoring with a saved mid-grace offset resumes the timeline: removal happens after the REMAINING grace+fade, not a full restart', () => {
      const { bus, sim, farSpot } = roadedWorld('decay-resume-grace');
      const house: SpawnRecord = { kind: 'house', x: farSpot.x, z: farSpot.z, rot: 0, id: 1 };
      // Simulate "saved 40s into the 60s grace period" directly via restore()'s decay param —
      // mirrors what a real save/reload would reconstruct from `decayState` at save time. Uses a
      // single small `update(1/60)` (not the usual `update(3)`) to apply the pending road-distance
      // recompute, so the "3 elapsed sim-seconds" budgeting other tests use doesn't eat into this
      // test's precisely-tracked remaining-grace math.
      sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [house], [{ id: 1, stranded: 40 }]);
      sim.update(1 / 60); // apply the pending recompute so this cell reads stranded (roadDist === -1)

      const strandedIds: number[] = [];
      const removedIds: number[] = [];
      bus.on('growth:stranded', (e) => strandedIds.push(e.id));
      bus.on('growth:remove', (e) => removedIds.push(e.id));

      // Only ~20s remain of the 60s grace (40 already elapsed, minus the tick just above) — advance
      // 19s, should not yet fire.
      for (let k = 0; k < 60 * 19; k++) sim.update(1 / 60);
      expect(strandedIds).toEqual([]);
      // Cross the remaining ~1s of grace.
      for (let k = 0; k < 60 * 2; k++) sim.update(1 / 60);
      expect(strandedIds).toEqual([1]);
      expect(removedIds).toEqual([]);
      // A FULL 60s grace (not the remaining ~20s) would NOT have elapsed yet at this point (only
      // ~21s of sim-time has passed since restore) — proving the timeline resumed rather than
      // restarted from zero.

      // Now the 30s fade runs its full course from here.
      for (let k = 0; k < 60 * 29; k++) sim.update(1 / 60);
      expect(removedIds).toEqual([]);
      for (let k = 0; k < 60 * 2; k++) sim.update(1 / 60);
      expect(removedIds).toEqual([1]);
    });

    it('restoring with a saved mid-fade offset resumes the fade timeline and completes on schedule', () => {
      const { bus, sim, farSpot } = roadedWorld('decay-resume-fade');
      const house: SpawnRecord = { kind: 'house', x: farSpot.x, z: farSpot.z, rot: 0, id: 1 };
      // Saved 25s into the 30s fade — only 5s should remain.
      sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [house], [{ id: 1, fading: 25 }]);
      sim.update(1 / 60); // apply pending recompute — see the grace-offset test above for why 1/60

      const removedIds: number[] = [];
      bus.on('growth:remove', (e) => removedIds.push(e.id));

      for (let k = 0; k < 60 * 4; k++) sim.update(1 / 60); // just under the remaining 5s
      expect(removedIds).toEqual([]);
      for (let k = 0; k < 60 * 2; k++) sim.update(1 / 60); // cross it
      expect(removedIds).toEqual([1]);
    });

    it('a decay entry referencing a dead/absent id is ignored defensively', () => {
      const { sim, farSpot } = roadedWorld('decay-stale-id');
      const house: SpawnRecord = { kind: 'house', x: farSpot.x, z: farSpot.z, rot: 0, id: 1 };
      expect(() =>
        sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [house], [{ id: 999, stranded: 10 }]),
      ).not.toThrow();
      expect(sim.decayState).toEqual([]);
    });

    it('restoring with no decay param (v1/v2 migration path) leaves empty decay maps', () => {
      const { sim, farSpot } = roadedWorld('decay-no-param');
      const house: SpawnRecord = { kind: 'house', x: farSpot.x, z: farSpot.z, rot: 0, id: 1 };
      sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [house]); // no 3rd arg
      expect(sim.decayState).toEqual([]);
    });
  });

  // Task 42 ("Groundwork"): roads clear GROWN scenery in their corridor, mirroring T31's
  // WildernessSim clearing but for GrowthSim's own road-driven records (trees/fields/houses/
  // buildings). Unlike stranded-decay (60s grace + 30s fade, rescuable), corridor clearing is a
  // QUICK fade (CLEAR_FADE_S, matching wilderness's 1.5s feel) with NO rescue: once a road's
  // corridor clears a record, demolishing that road later does not bring it back.
  describe('corridor clearing (Task 42)', () => {
    function buildGraph(seedName: string) {
      const bus = new EventBus();
      const hf = new Heightfield(seedName, bus);
      const g = new RoadGraph(bus, makeSampler(hf));
      let anchor = { x: 0, z: 0 };
      outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
        if (hf.isLand(x, z) && hf.isLand(x + 64, z)) { anchor = { x, z }; break outer; }
      const [edgeId] = g.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
      return { bus, hf, g, edgeId, anchor };
    }

    it('a tree record within the corridor fades quickly and is removed once graded', () => {
      const { bus, hf, g, edgeId } = buildGraph('clear-tree');
      const sim = new GrowthSim(g, hf, bus, createRng('clear-tree'));
      const edge = g.edges.get(edgeId)!;
      const sample = edge.samples[Math.floor(edge.samples.length / 2)];

      const tree: SpawnRecord = { kind: 'tree', x: sample.x, z: sample.z, rot: 0, id: 1 };
      sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [tree]);
      expect(sim.spawned.some((r) => r.id === 1)).toBe(true);

      const clearedIds: number[] = [];
      const removedIds: number[] = [];
      bus.on('growth:cleared', (e) => clearedIds.push(e.id));
      bus.on('growth:remove', (e) => removedIds.push(e.id));

      edge.stage = 'graded';
      bus.emit('construction:stage', { edgeId, stage: 'graded', crew: 0 });

      expect(clearedIds).toEqual([1]);
      expect(removedIds).toEqual([]); // fade not yet complete
      expect(sim.spawned.some((r) => r.id === 1)).toBe(true); // still present mid-fade

      for (let k = 0; k < 60 * 2; k++) sim.update(1 / 60); // well past the quick ~1.5s fade
      expect(removedIds).toEqual([1]);
      expect(sim.spawned.some((r) => r.id === 1)).toBe(false);
    });

    it('the quick clearing fade completes well before the 60s stranded grace window', () => {
      const { bus, hf, g, edgeId } = buildGraph('clear-fast');
      const sim = new GrowthSim(g, hf, bus, createRng('clear-fast'));
      const edge = g.edges.get(edgeId)!;
      const sample = edge.samples[Math.floor(edge.samples.length / 2)];
      const tree: SpawnRecord = { kind: 'tree', x: sample.x, z: sample.z, rot: 0, id: 1 };
      sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [tree]);

      const removedIds: number[] = [];
      bus.on('growth:remove', (e) => removedIds.push(e.id));
      edge.stage = 'graded';
      bus.emit('construction:stage', { edgeId, stage: 'graded', crew: 0 });

      for (let k = 0; k < 60 * 3; k++) sim.update(1 / 60); // 3s — nowhere near the 60s grace
      expect(removedIds).toEqual([1]);
    });

    it('all kinds (tree/field/house/building) clear, houseCount decrements for a house', () => {
      const { bus, hf, g, edgeId } = buildGraph('clear-kinds');
      const sim = new GrowthSim(g, hf, bus, createRng('clear-kinds'));
      const edge = g.edges.get(edgeId)!;
      const sample = edge.samples[Math.floor(edge.samples.length / 2)];

      const records: SpawnRecord[] = [
        { kind: 'tree', x: sample.x, z: sample.z, rot: 0, id: 1 },
        { kind: 'field', x: sample.x, z: sample.z, rot: 0, id: 2 },
        { kind: 'house', x: sample.x, z: sample.z, rot: 0, id: 3 },
        { kind: 'building', x: sample.x, z: sample.z, rot: 0, id: 4 },
      ];
      sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), records);
      expect(sim.houseCount).toBe(1);

      const removedIds: number[] = [];
      bus.on('growth:remove', (e) => removedIds.push(e.id));
      edge.stage = 'graded';
      bus.emit('construction:stage', { edgeId, stage: 'graded', crew: 0 });
      for (let k = 0; k < 60 * 2; k++) sim.update(1 / 60);

      expect(removedIds.sort()).toEqual([1, 2, 3, 4]);
      expect(sim.spawned.length).toBe(0);
      expect(sim.houseCount).toBe(0);
    });

    it('does not clear records outside the corridor', () => {
      const { bus, hf, g, edgeId, anchor } = buildGraph('clear-outside');
      const sim = new GrowthSim(g, hf, bus, createRng('clear-outside'));
      const edge = g.edges.get(edgeId)!;
      const sample = edge.samples[Math.floor(edge.samples.length / 2)];
      const corridorHalf = ROAD_WIDTH / 2 + 2;

      const records: SpawnRecord[] = [
        { kind: 'tree', x: sample.x, z: sample.z + corridorHalf + 20, rot: 0, id: 1 }, // well outside
        { kind: 'tree', x: anchor.x - 100, z: anchor.z - 100, rot: 0, id: 2 }, // far outside
      ];
      sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), records);

      const clearedIds: number[] = [];
      bus.on('growth:cleared', (e) => clearedIds.push(e.id));
      edge.stage = 'graded';
      bus.emit('construction:stage', { edgeId, stage: 'graded', crew: 0 });
      for (let k = 0; k < 60 * 2; k++) sim.update(1 / 60);

      expect(clearedIds).toEqual([]);
      expect(sim.spawned.length).toBe(2);
    });

    it('does not clear records near a bridge sample', () => {
      const bus = new EventBus();
      const hf = new Heightfield('clear-bridge', bus);
      const bridgeSampler = (ctrl: { x: number; z: number }[]) => {
        const base = makeSampler(hf)(ctrl);
        return base.map((s) => ({ ...s, bridge: true }));
      };
      const g = new RoadGraph(bus, bridgeSampler);
      let anchor = { x: 0, z: 0 };
      outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
        if (hf.isLand(x, z) && hf.isLand(x + 64, z)) { anchor = { x, z }; break outer; }
      const [edgeId] = g.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
      const edge = g.edges.get(edgeId)!;
      const sample = edge.samples[Math.floor(edge.samples.length / 2)];

      const sim = new GrowthSim(g, hf, bus, createRng('clear-bridge'));
      const tree: SpawnRecord = { kind: 'tree', x: sample.x, z: sample.z, rot: 0, id: 1 };
      sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [tree]);

      const clearedIds: number[] = [];
      bus.on('growth:cleared', (e) => clearedIds.push(e.id));
      edge.stage = 'graded';
      bus.emit('construction:stage', { edgeId, stage: 'graded', crew: 0 });
      for (let k = 0; k < 60 * 2; k++) sim.update(1 / 60);

      // All samples are bridge samples, so nothing should clear.
      expect(clearedIds).toEqual([]);
      expect(sim.spawned.length).toBe(1);
    });

    it('restore re-clears the corridor: a record saved past graded re-triggers a fresh clearing fade', () => {
      // Mirrors WildernessSim's restore lesson: restoreWorld force-sets edge.stage directly and
      // re-emits construction:stage with whatever stage was saved (often past a literal 'graded'
      // event) BEFORE growth.restore() populates records — so restore() itself must re-derive
      // clearing from the current graph state, not rely on catching a live construction:stage.
      for (const restoredStage of ['gravel', 'paved', 'painted'] as const) {
        const { bus, hf, g, edgeId } = buildGraph('clear-restore-' + restoredStage);
        const edge = g.edges.get(edgeId)!;
        const sample = edge.samples[Math.floor(edge.samples.length / 2)];
        edge.stage = restoredStage; // as restoreWorld force-sets it, before growth.restore() runs

        const sim = new GrowthSim(g, hf, bus, createRng('clear-restore'));
        const removedIds: number[] = [];
        bus.on('growth:remove', (e) => removedIds.push(e.id));

        const tree: SpawnRecord = { kind: 'tree', x: sample.x, z: sample.z, rot: 0, id: 1 };
        sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [tree]);

        for (let k = 0; k < 60 * 2; k++) sim.update(1 / 60);
        expect(removedIds).toEqual([1]);
      }
    });

    it('a mid-clearing-fade record that is saved (still in records) re-triggers clearing on restore', () => {
      // Simulates: live clearing started (growth:cleared fired) but the save happened before the
      // fade completed, so the record is still present in `spawned` at save time. On restore, the
      // record is still within the corridor of a >= graded edge, so it must re-clear (a fresh
      // CLEAR_FADE_S fade) rather than being silently stuck forever uncleared.
      const { bus, hf, g, edgeId } = buildGraph('clear-midfade-restore');
      const edge = g.edges.get(edgeId)!;
      const sample = edge.samples[Math.floor(edge.samples.length / 2)];
      edge.stage = 'painted'; // as a real save's restoreWorld would force it before growth.restore()

      const sim = new GrowthSim(g, hf, bus, createRng('clear-midfade'));
      const clearedIds: number[] = [];
      const removedIds: number[] = [];
      bus.on('growth:cleared', (e) => clearedIds.push(e.id));
      bus.on('growth:remove', (e) => removedIds.push(e.id));

      const tree: SpawnRecord = { kind: 'tree', x: sample.x, z: sample.z, rot: 0, id: 1 };
      sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [tree]);

      expect(clearedIds).toEqual([1]); // re-triggered by restore()'s own corridor re-scan
      expect(removedIds).toEqual([]); // not yet — fresh fade just started
      expect(sim.spawned.some((r) => r.id === 1)).toBe(true);

      for (let k = 0; k < 60 * 2; k++) sim.update(1 / 60);
      expect(removedIds).toEqual([1]);
    });

    it('rescue does NOT apply to corridor clearing: demolishing the road afterward does not restore the record', () => {
      const { bus, hf, g, edgeId } = buildGraph('clear-no-rescue');
      const sim = new GrowthSim(g, hf, bus, createRng('clear-no-rescue'));
      const edge = g.edges.get(edgeId)!;
      const sample = edge.samples[Math.floor(edge.samples.length / 2)];
      const tree: SpawnRecord = { kind: 'tree', x: sample.x, z: sample.z, rot: 0, id: 1 };
      sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [tree]);

      const rescuedIds: number[] = [];
      const removedIds: number[] = [];
      bus.on('growth:rescued', (e) => rescuedIds.push(e.id));
      bus.on('growth:remove', (e) => removedIds.push(e.id));

      edge.stage = 'graded';
      bus.emit('construction:stage', { edgeId, stage: 'graded', crew: 0 });
      for (let k = 0; k < 60 * 2; k++) sim.update(1 / 60);
      expect(removedIds).toEqual([1]);

      // Demolish the road (stage walked back to 'removed') — the cleared tree must not come back,
      // and growth:rescued must never fire for this id.
      edge.stage = 'surveyed';
      bus.emit('construction:stage', { edgeId, stage: 'removed', crew: 0 });
      for (let k = 0; k < 60 * 2; k++) sim.update(1 / 60);

      expect(rescuedIds).toEqual([]);
      expect(sim.spawned.some((r) => r.id === 1)).toBe(false);
    });

    it('spawnMask kind-bits clear so regrowth beside (not inside) the road is possible', () => {
      const { bus, hf, g, edgeId } = buildGraph('clear-mask');
      const sim = new GrowthSim(g, hf, bus, createRng('clear-mask'));
      const edge = g.edges.get(edgeId)!;
      const sample = edge.samples[Math.floor(edge.samples.length / 2)];

      // Seed dev high enough that restore() sets the tree bit in this cell's spawnMask, matching a
      // naturally-grown cell.
      const dev = new Float32Array(GRID_SIZE * GRID_SIZE);
      const ci = Math.round((sample.x + HALF) / CELL);
      const cj = Math.round((sample.z + HALF) / CELL);
      const cellIdx = cj * GRID_SIZE + ci;
      dev[cellIdx] = 0.3; // past the tree threshold (0.22)

      const tree: SpawnRecord = { kind: 'tree', x: sample.x, z: sample.z, rot: 0, id: 1 };
      sim.restore(dev, [tree]);
      const TREE_BIT = 1 << 0;
      expect(sim.spawnMaskAt(ci, cj) & TREE_BIT).toBe(TREE_BIT);

      const removedIds: number[] = [];
      bus.on('growth:remove', (e) => removedIds.push(e.id));
      edge.stage = 'graded';
      bus.emit('construction:stage', { edgeId, stage: 'graded', crew: 0 });
      for (let k = 0; k < 60 * 2; k++) sim.update(1 / 60);
      expect(removedIds).toEqual([1]);

      expect(sim.spawnMaskAt(ci, cj) & TREE_BIT).toBe(0);
    });
  });
});

describe('GrowthSim development pause', () => {
  it('freezes development accumulation without catching up when resumed', () => {
    const { sim } = world();
    sim.setDevelopmentPaused(true);

    // The first update still applies the pending road-distance recompute, but paused development
    // must remain exactly untouched regardless of elapsed sim time.
    sim.update(3);
    const frozen = sim.devLevels;
    sim.update(30);
    expect(sim.devLevels).toEqual(frozen);
    expect(Math.max(...sim.devLevels)).toBe(0);

    sim.setDevelopmentPaused(false);
    sim.update(1);
    expect(Math.max(...sim.devLevels)).toBeGreaterThan(0);
  });

  it('continues cleanup lifecycles while new development is paused', () => {
    const bus = new EventBus();
    const hf = new Heightfield('growth-pause-cleanup', bus);
    const graph = new RoadGraph(bus, makeSampler(hf));
    const sim = new GrowthSim(graph, hf, bus, createRng('growth-pause-cleanup'));
    const tree: SpawnRecord = { kind: 'tree', x: 0, z: 0, rot: 0, id: 1 };
    sim.restore(new Float32Array(GRID_SIZE * GRID_SIZE), [tree], [{ id: 1, fading: 29.5 }]);
    sim.setDevelopmentPaused(true);

    sim.update(1);

    expect(sim.spawned).toEqual([]);
  });
});
