import { describe, it, expect } from 'vitest';
import { BuildQueue } from '../src/sim/construction/queue';
import { RoadGraph } from '../src/sim/roads/graph';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { makeSampler, sampleAt } from '../src/sim/roads/path';
import { GrowthSim } from '../src/sim/growth/growth';
import { restoreWorld, type SaveV3 } from '../src/sim/save';
import { EventBus } from '../src/core/events';
import { createRng } from '../src/core/rng';
import { GRID_SIZE, CELL, WORLD_SIZE, ROAD_WIDTH } from '../src/core/constants';

/**
 * Regression coverage for "grass and ground still rendering above the road" (Task 24 — second
 * playtest occurrence, after the T18 clampBelow/finalization fix reduced but did not eliminate
 * it). Reproduces the scenario from the bug report: a road built across a steep hillside
 * cross-slope, so terrain rises sharply on one side of the ribbon relative to the other along the
 * road's *perpendicular* axis — the axis clampBelow/flattenCircle actually have to fight.
 *
 * Rather than searching procedural noise for a slope steep enough to trigger the bug (flaky,
 * seed-dependent, and hard to reason about), these tests sculpt a deterministic linear ramp
 * directly onto the heightfield grid — height rises linearly along Z, constant along X — then
 * build a road straight through it, both axis-aligned (worst case for the ramp direction) and
 * diagonal (the realistic case, since most roads aren't grid-aligned; the diagonal + gentle-slope
 * combination turned out to be the clearest real-world trigger — see task-24-report.md).
 *
 * These same hillside scenarios also cover the DOWNHILL direction named in the original spec but
 * never previously asserted: "no new artifacts (cliffs, ribbon-edge gaps over trenches)" — terrain
 * sitting far enough BELOW the ribbon edge that the (skirt-less) ribbon geometry would visibly
 * float over a gap. `scanDownhillEdges` checks, at each ribbon edge and 2u further outside it, that
 * the drop from the road surface to terrain doesn't exceed what the ribbon can visually bridge.
 * The report argued `flattenCircle`'s embankment blending prevents this; measured numbers across
 * all scenarios (worst edge gap 0.755u, worst outside-drop 2.0u) confirm it holds with margin —
 * see task-24-report.md's "Downhill-edge coverage" section for the full numbers.
 */

const SURVEY_SPEED = 20; // must match BuildQueue's own constant — every fresh build starts with a
                          // surveyor pass at this speed before grading begins at all.
const GRADE_SPEED = 6;

function setLinearRampZ(hf: Heightfield, slope: number, baseAtZ0: number): void {
  const half = WORLD_SIZE / 2;
  for (let j = 0; j < GRID_SIZE; j++) {
    const z = j * CELL - half;
    const h = baseAtZ0 + slope * z;
    for (let i = 0; i < GRID_SIZE; i++) {
      hf.heights[j * GRID_SIZE + i] = h;
    }
  }
}

const run = (queue: BuildQueue, seconds: number) => {
  for (let i = 0; i < seconds * 60; i++) queue.update(1 / 60);
};

/** Runs the queue past the initial survey pass (SURVEY_SPEED over `edgeLengthU`) plus
 * `gradingSeconds` more of actual grading — i.e. "mid-construction, partway through grading." */
function runIntoGrading(queue: BuildQueue, edgeLengthU: number, gradingSeconds: number): void {
  run(queue, edgeLengthU / SURVEY_SPEED + gradingSeconds);
}

interface Violation {
  t: number;
  offset: number;
  x: number;
  z: number;
  terrainY: number;
  roadY: number;
  excess: number; // terrainY - (roadY + yLift)
}

/**
 * Scans a dense lattice across the ribbon footprint: every 2u along the edge's arclength
 * (matching road sample spacing), every 0.5u in perpendicular offset from -ROAD_WIDTH/2 to
 * +ROAD_WIDTH/2 (the full visible ribbon), comparing `hf.heightAt` against the interpolated road
 * surface Y (+ the given ribbon yLift — pass the lowest in-use lift, 'graded' at 0.06, since
 * higher stages only lift the ribbon further away from the terrain and are strictly safer).
 */
function scanRibbonFootprint(
  hf: Heightfield,
  samples: { x: number; y: number; z: number; bridge: boolean }[],
  edgeLength: number,
  yLift: number,
): Violation[] {
  const violations: Violation[] = [];
  const halfWidth = ROAD_WIDTH / 2;
  for (let t = 0; t <= edgeLength; t += 2) {
    const { pos, heading } = sampleAt(samples, t);
    const perpX = -Math.sin(heading);
    const perpZ = Math.cos(heading);
    for (let offset = -halfWidth; offset <= halfWidth + 1e-9; offset += 0.5) {
      const x = pos.x + perpX * offset;
      const z = pos.z + perpZ * offset;
      const terrainY = hf.heightAt(x, z);
      const roadY = pos.y;
      const excess = terrainY - (roadY + yLift);
      if (excess > 0) violations.push({ t, offset, x, z, terrainY, roadY, excess });
    }
  }
  return violations;
}

interface EdgeDropSample {
  t: number;
  sign: -1 | 1;
  edgeGap: number; // roadY - terrainY at the ribbon edge (positive = terrain sits below road)
  outsideDrop: number; // terrainY(ribbon edge) - terrainY(2u further out) — the "cliff" step
}

/**
 * Downhill counterpart to `scanRibbonFootprint`: rather than checking for terrain poking ABOVE
 * the road (the T24 bug), this checks the opposite failure mode named in the original spec but
 * never covered by a test — terrain sitting so far BELOW the ribbon edge that the (skirt-less)
 * ribbon geometry would visibly float over a gap or show a sheer cliff at its edge. Scans the same
 * lattice arclength spacing as `scanRibbonFootprint`, but only at the two ribbon edges
 * (+-ROAD_WIDTH/2) and a point 2u further outside each one, since that's where a downhill cliff
 * would actually render.
 */
function scanDownhillEdges(
  hf: Heightfield,
  samples: { x: number; y: number; z: number; bridge: boolean }[],
  edgeLength: number,
  yLift: number,
  minT = 0,
): EdgeDropSample[] {
  const halfWidth = ROAD_WIDTH / 2;
  const out: EdgeDropSample[] = [];
  for (let t = minT; t <= edgeLength; t += 2) {
    const { pos, heading } = sampleAt(samples, t);
    const perpX = -Math.sin(heading);
    const perpZ = Math.cos(heading);
    for (const sign of [-1, 1] as const) {
      const edgeX = pos.x + perpX * halfWidth * sign;
      const edgeZ = pos.z + perpZ * halfWidth * sign;
      const edgeTerrainY = hf.heightAt(edgeX, edgeZ);
      const roadY = pos.y + yLift;
      const edgeGap = roadY - edgeTerrainY;

      const outX = pos.x + perpX * (halfWidth + 2) * sign;
      const outZ = pos.z + perpZ * (halfWidth + 2) * sign;
      const outTerrainY = hf.heightAt(outX, outZ);
      const outsideDrop = edgeTerrainY - outTerrainY;

      out.push({ t, sign, edgeGap, outsideDrop });
    }
  }
  return out;
}

function setupAxisAligned(slope: number, edgeLengthU: number) {
  const bus = new EventBus();
  const hf = new Heightfield('ramp-test', bus);
  // Sculpt the cross-slope BEFORE any road sampling happens, so the road's own slope-limited Y
  // profile (computed from ground height in makeSampler) reflects it too.
  setLinearRampZ(hf, slope, 10);
  const graph = new RoadGraph(bus, makeSampler(hf));
  const queue = new BuildQueue(graph, hf, bus);
  // East-west road (varies in X, constant Z=0) — perpendicular to the Z-ramp, i.e. straight across
  // the steepest possible cross-slope direction relative to the grid axes.
  const half = edgeLengthU / 2;
  const [edgeId] = graph.commitChain([{ x: -half, z: 0 }, { x: half, z: 0 }]);
  return { bus, hf, graph, queue, edgeId };
}

function setupDiagonal(slope: number, edgeLengthU: number) {
  const bus = new EventBus();
  const hf = new Heightfield('ramp-test-diag', bus);
  setLinearRampZ(hf, slope, 10);
  const graph = new RoadGraph(bus, makeSampler(hf));
  const queue = new BuildQueue(graph, hf, bus);
  const half = edgeLengthU / 2;
  // Diagonal (45 degree) road — grid-cell edges no longer align with the road's local axes at
  // all, which is the realistic case (most roads aren't perfectly axis-aligned with the 4u grid).
  const d = half / Math.SQRT2;
  const [edgeId] = graph.commitChain([{ x: -d, z: -d }, { x: d, z: d }]);
  return { bus, hf, graph, queue, edgeId };
}

describe('road/terrain clamp — steep cross-slope regression (Task 24)', () => {
  it('REPRODUCE(axis-aligned): no terrain pokes above the road mid-construction (behind the work front)', () => {
    // slope 0.6 is well above MAX_ROAD_GRADE (0.35): terrain climbs faster across the corridor
    // than the road profile follows — the "steep hillside contour" scenario from the bug report.
    const { queue, hf, graph, edgeId } = setupAxisAligned(0.6, 64);
    runIntoGrading(queue, 64, 3); // 3s of actual grading past the survey pass: front at ~18u of 64u
    const edge = graph.edges.get(edgeId)!;
    const violations = scanRibbonFootprint(hf, edge.samples, edge.length, 0.06 - 0.02); // 0.02 margin
    const workFrontT = 3 * GRADE_SPEED;
    const behindFront = violations.filter((v) => v.t < workFrontT - CELL * 2); // stay well behind the front
    expect(behindFront.length).toBe(0);

    // Downhill check, behind the front only (same rationale as above: right at the front the
    // excavator hasn't graded yet, so a transient gap there isn't the bug under test). Measured
    // worst case behind the front: edge gap 0.04u, outside-drop 1.2u.
    const drops = scanDownhillEdges(hf, edge.samples, edge.length, 0.06 - 0.02, 0)
      .filter((d) => d.t < workFrontT - CELL * 2);
    for (const d of drops) {
      expect(d.edgeGap).toBeLessThanOrEqual(1.0);
      expect(d.outsideDrop).toBeLessThanOrEqual(2.5);
    }
  });

  it('REPRODUCE(axis-aligned): no terrain pokes above the road once fully built', () => {
    const { queue, hf, graph, edgeId } = setupAxisAligned(0.6, 64);
    run(queue, 120); // full build through painted
    const edge = graph.edges.get(edgeId)!;
    expect(edge.stage).toBe('painted');
    const violations = scanRibbonFootprint(hf, edge.samples, edge.length, 0.06 - 0.02);
    expect(violations.length).toBe(0);

    // Downhill direction (spec also required "no new artifacts (cliffs, ribbon-edge gaps over
    // trenches)" — never previously checked). Measured worst case on this scenario: edge gap
    // 0.04u, outside-drop 1.2u — comfortably inside tolerance; asserted tight (not the full
    // 1.5/3.5 ceiling from the spec) to lock in the real observed margin.
    const drops = scanDownhillEdges(hf, edge.samples, edge.length, 0.06 - 0.02);
    for (const d of drops) {
      expect(d.edgeGap).toBeLessThanOrEqual(1.0);
      expect(d.outsideDrop).toBeLessThanOrEqual(2.5);
    }
  });

  it('REPRODUCE(axis-aligned): steeper slope (1.0) still holds after full build', () => {
    const { queue, hf, graph, edgeId } = setupAxisAligned(1.0, 64);
    run(queue, 120);
    const edge = graph.edges.get(edgeId)!;
    const violations = scanRibbonFootprint(hf, edge.samples, edge.length, 0.06 - 0.02);
    expect(violations.length).toBe(0);

    // Steeper ramp (1.0) is the worst case for the downhill "outside-drop" cliff metric too
    // (measured 2.0u here vs 1.2u at slope 0.6) — still well inside the ~3.5u ceiling the spec
    // allows for "no sheer cliff."
    const drops = scanDownhillEdges(hf, edge.samples, edge.length, 0.06 - 0.02);
    for (const d of drops) {
      expect(d.edgeGap).toBeLessThanOrEqual(1.0);
      expect(d.outsideDrop).toBeLessThanOrEqual(2.5);
    }
  });

  it('REPRODUCE(diagonal, gentle slope, no bridge): no terrain pokes above the road once fully built', () => {
    // slope 0.3 stays under MAX_ROAD_GRADE (0.35) so the road never becomes a bridge (bridge
    // samples are legitimately excluded from grading/clamping) — isolates the diagonal
    // grid/off-axis-coverage effect from bridge-skip behavior. This was the configuration that
    // most clearly reproduced the second occurrence: grid vertices near the ribbon edge, off-axis
    // from any single flattenCircle/clampBelow center, retained meaningful excess height even
    // after the T18 finalization pass.
    const { queue, hf, graph, edgeId } = setupDiagonal(0.3, 64);
    run(queue, 30);
    const edge = graph.edges.get(edgeId)!;
    expect(edge.samples.every((s) => !s.bridge)).toBe(true); // confirm this path stayed graded, not bridged
    const violations = scanRibbonFootprint(hf, edge.samples, edge.length, 0.06 - 0.02);
    expect(violations.length).toBe(0);

    // Downhill check: the diagonal case is the worst measured edge-gap of all scenarios (0.755u,
    // off-axis grid vertices near the ribbon edge sit a bit further below the road profile than
    // the axis-aligned case) — still well under the 1.5u the ribbon can visually bridge.
    const drops = scanDownhillEdges(hf, edge.samples, edge.length, 0.06 - 0.02);
    for (const d of drops) {
      expect(d.edgeGap).toBeLessThanOrEqual(1.0);
      expect(d.outsideDrop).toBeLessThanOrEqual(2.5);
    }
  });

  it('REPRODUCE(diagonal, gentle slope): no terrain pokes above the road mid-construction', () => {
    const { queue, hf, graph, edgeId } = setupDiagonal(0.3, 64);
    runIntoGrading(queue, 64, 3);
    const edge = graph.edges.get(edgeId)!;
    const violations = scanRibbonFootprint(hf, edge.samples, edge.length, 0.06 - 0.02);
    const workFrontT = 3 * GRADE_SPEED;
    const behindFront = violations.filter((v) => v.t < workFrontT - CELL * 2);
    expect(behindFront.length).toBe(0);

    // Downhill check, behind the front only. Measured worst case: edge gap 0.676u, outside-drop
    // 0.534u — under the same tolerances as the other scenarios.
    const drops = scanDownhillEdges(hf, edge.samples, edge.length, 0.06 - 0.02, 0)
      .filter((d) => d.t < workFrontT - CELL * 2);
    for (const d of drops) {
      expect(d.edgeGap).toBeLessThanOrEqual(1.0);
      expect(d.outsideDrop).toBeLessThanOrEqual(2.5);
    }
  });

  it('demolish (reverse grading) leaves no lingering above-road terrain either', () => {
    // Sanity check: a road demolished back down shouldn't leave stale clamped/flattened terrain
    // artifacts that then read as violations against a *different*, still-standing road nearby.
    // Not a primary repro of the reported bug, but cheap insurance given clampBelow/flattenCircle
    // are shared machinery with the forward build path.
    const { queue, graph, edgeId } = setupAxisAligned(0.6, 64);
    run(queue, 120); // full build
    queue.enqueueDemolish(edgeId);
    run(queue, 120); // full demolish
    expect(graph.edges.has(edgeId)).toBe(false);
  });
});

/**
 * Third occurrence ("I was still seeing grass on top of the road", post-T24/v2). T24's
 * anisotropic clampBelow enforcement runs at grading completion + a mid-build trailing window +
 * save.ts's restore path — but only ever at THOSE call sites. Terrain deforms again AFTER a road
 * finishes: growth spawns houses/buildings along the corridor (Task 30 setback band, 8-10u from
 * the centerline sample), and `SceneryRenderer.onSpawn` -> `place()` (src/render/sceneryRenderer.ts
 * line ~689) calls `hf.flattenCircle(rec.x, rec.z, y, FLATTEN_RADIUS=5)` to carve the house's own
 * pad — a *render-side* call directly against the shared sim Heightfield, completely outside
 * BuildQueue/save.ts's clamp-aware machinery. `flattenCircle` blends terrain TOWARD the pad's own
 * ground height; on a hillside where the house sits uphill of a cut road, that target is above
 * road grade, so the blend RAISES corridor-adjacent terrain that clampBelow already flattened.
 * Nothing re-clamped afterward — UNTIL this fix.
 *
 * BEFORE the fix (measured against this exact suite, see task-43-report.md for full numbers):
 *   - single house at minimum (8u) setback, axis-aligned slope 0.6: 3 violations, worst excess 0.026u
 *   - full T30 band [8,10] both sides, 3 points along a 64u road: 24 violations, worst excess 0.072u
 *   - dense "developed street" (both sides, every 4u), axis-aligned slope 0.6/1.0/1.5:
 *     104 / 131 / 133 violations, worst excess 0.079u / 0.107u / 0.141u (grows with slope)
 *   - dense band on the gentle (0.3) diagonal (T24's own worst-case geometry): 0 violations (this
 *     particular slope/geometry combination didn't trip the bug — real negative evidence, kept
 *     below as a probe, not a claim the bug never manifests on a diagonal road)
 *
 * AFTER the fix (`Heightfield.registerRoadEasement` + re-enforcement from `flattenCircle` — see
 * heightfield.ts): every scenario above is asserted at 0 violations.
 *
 * This reproduces/proves it exactly the way the renderer does: build a road on the same steep
 * hillside ramp T24 used, run it to `painted` completion (so the corridor is provably clean
 * beforehand — see the baseline assertion below, plus `finalizeGrading` now also registers the
 * standing easement), then place a house at a realistic T30 setback and call the SAME
 * `flattenCircle(x, z, heightAt(x, z), FLATTEN_RADIUS)` the renderer calls, then re-scan the
 * corridor lattice.
 */
describe('road/terrain clamp — house-pad flatten vs. corridor (third occurrence, Task 43)', () => {
  const FLATTEN_RADIUS = 5; // must match sceneryRenderer.ts's own constant
  const SETBACK_MIN = 8; // must match growth.ts's own SETBACK_MIN/SETBACK_MAX (band is [8, 10])

  it('BASELINE: corridor is clean immediately after grading completes (T24 still holds)', () => {
    const { queue, hf, graph, edgeId } = setupAxisAligned(0.6, 64);
    run(queue, 120);
    const edge = graph.edges.get(edgeId)!;
    expect(edge.stage).toBe('painted');
    const violations = scanRibbonFootprint(hf, edge.samples, edge.length, 0.06 - 0.02);
    expect(violations.length).toBe(0);
  });

  it('PROVE: a house pad flattened at T30 setback no longer re-raises terrain above the road', () => {
    const { queue, hf, graph, edgeId } = setupAxisAligned(0.6, 64);
    run(queue, 120); // full build, corridor clean per baseline above
    const edge = graph.edges.get(edgeId)!;

    // Place a house at the uphill side (+Z, where the ramp is higher), at the T30 minimum
    // setback (worst case: closest legal distance to the corridor), abreast of the road's
    // midpoint sample — exactly what GrowthSim.placeFacingRoad + SceneryRenderer.place do between
    // them, reproduced directly against the real Heightfield/RoadGraph rather than mocked.
    const midT = edge.length / 2;
    const { pos, heading } = sampleAt(edge.samples, midT);
    const perpX = -Math.sin(heading);
    const perpZ = Math.cos(heading);
    const setback = SETBACK_MIN; // worst case: closest legal distance
    const houseX = pos.x + perpX * setback;
    const houseZ = pos.z + perpZ * setback;

    const groundY = hf.heightAt(houseX, houseZ);
    // This is the exact call sceneryRenderer.ts makes on spawn/restore for a house or building.
    hf.flattenCircle(houseX, houseZ, groundY, FLATTEN_RADIUS);

    const violations = scanRibbonFootprint(hf, edge.samples, edge.length, 0.06 - 0.02);
    // eslint-disable-next-line no-console
    console.log(
      `[house-pad] setback=${setback} groundY=${groundY.toFixed(2)} ` +
      `violations=${violations.length} worstExcess=${violations.length ? Math.max(...violations.map(v => v.excess)).toFixed(3) : 0}`,
    );
    expect(violations.length).toBe(0); // was 3 (worst excess 0.026u) before the easement fix
  });

  it('PROVE: sweeping the full T30 setback band [8,10] against every corridor side stays clean', () => {
    const { queue, hf, graph, edgeId } = setupAxisAligned(0.6, 64);
    run(queue, 120);
    const edge = graph.edges.get(edgeId)!;

    for (const setback of [8, 8.5, 9, 9.5, 10]) {
      for (const side of [-1, 1] as const) {
        for (const t of [16, 32, 48]) {
          const { pos, heading } = sampleAt(edge.samples, t);
          const perpX = -Math.sin(heading);
          const perpZ = Math.cos(heading);
          const houseX = pos.x + perpX * setback * side;
          const houseZ = pos.z + perpZ * setback * side;
          const groundY = hf.heightAt(houseX, houseZ);
          hf.flattenCircle(houseX, houseZ, groundY, FLATTEN_RADIUS);
        }
      }
    }
    const violations = scanRibbonFootprint(hf, edge.samples, edge.length, 0.06 - 0.02);
    const worstExcess = violations.length ? Math.max(...violations.map(v => v.excess)) : 0;
    // eslint-disable-next-line no-console
    console.log(`[house-pad, full band] violations=${violations.length} worstExcess=${worstExcess.toFixed(3)}`);
    expect(violations.length).toBe(0); // was 24 (worst excess 0.072u) before the easement fix
  });

  it('PROVE(diagonal, gentle slope, no bridge): dense band stays clean (matches pre-fix negative finding)', () => {
    // T24's own worst measured case (clean, non-bridged) was diagonal + gentle slope 0.3 (off-axis
    // grid coverage) — baseline is 0 violations per the existing suite. This particular
    // slope/geometry combination happened not to trip the bug even before the fix (real negative
    // evidence, not proof the bug is geometry-proof) — kept as a probe/regression guard so a
    // future change can't silently reintroduce violations here either.
    const { queue, hf, graph, edgeId } = setupDiagonal(0.3, 64);
    run(queue, 60);
    const edge = graph.edges.get(edgeId)!;
    expect(edge.samples.every((s) => !s.bridge)).toBe(true);
    const baseline = scanRibbonFootprint(hf, edge.samples, edge.length, 0.06 - 0.02);
    expect(baseline.length).toBe(0); // confirm clean baseline (matches existing suite's finding)

    for (const setback of [8, 8.5, 9, 9.5, 10]) {
      for (const side of [-1, 1] as const) {
        for (let t = 8; t <= edge.length - 8; t += 4) {
          const { pos, heading } = sampleAt(edge.samples, t);
          const perpX = -Math.sin(heading);
          const perpZ = Math.cos(heading);
          const houseX = pos.x + perpX * setback * side;
          const houseZ = pos.z + perpZ * setback * side;
          const groundY = hf.heightAt(houseX, houseZ);
          hf.flattenCircle(houseX, houseZ, groundY, FLATTEN_RADIUS);
        }
      }
    }
    const after = scanRibbonFootprint(hf, edge.samples, edge.length, 0.06 - 0.02);
    // eslint-disable-next-line no-console
    console.log(
      `[diagonal dense] violations=${after.length} ` +
      `worstExcess=${after.length ? Math.max(...after.map(v => v.excess)).toFixed(3) : 0}`,
    );
    expect(after.length).toBe(0);
  });

  it('PROVE(axis-aligned, steeper slopes): dense "developed street" (both sides) stays clean with margin', () => {
    // Simulates a realistic developed street: houses lining BOTH sides of the road at the T30
    // setback band, every 4u of arclength (dense — a fully "grown" street). Before the fix this
    // was the clearest, largest-magnitude reproduction (104/131/133 violations at slope
    // 0.6/1.0/1.5, worst excess up to 0.141u); now asserted clean at every slope.
    const results: Record<number, { baseline: number; after: number; worstExcess: number }> = {};
    for (const slope of [0.6, 1.0, 1.5]) {
      const { queue, hf, graph, edgeId } = setupAxisAligned(slope, 64);
      run(queue, 120);
      const edge = graph.edges.get(edgeId)!;
      const baseline = scanRibbonFootprint(hf, edge.samples, edge.length, 0.06 - 0.02);
      expect(baseline.length).toBe(0); // T24 still holds immediately post-grading (confirms it's not stale)

      for (const setback of [8, 8.5, 9, 9.5, 10]) {
        for (const side of [-1, 1] as const) {
          for (let t = 8; t <= edge.length - 8; t += 4) {
            const { pos, heading } = sampleAt(edge.samples, t);
            const perpX = -Math.sin(heading);
            const perpZ = Math.cos(heading);
            const houseX = pos.x + perpX * setback * side;
            const houseZ = pos.z + perpZ * setback * side;
            const groundY = hf.heightAt(houseX, houseZ);
            // This is the exact call sceneryRenderer.ts's place() makes for every house/building.
            hf.flattenCircle(houseX, houseZ, groundY, FLATTEN_RADIUS);
          }
        }
      }
      const after = scanRibbonFootprint(hf, edge.samples, edge.length, 0.06 - 0.02);
      const worstExcess = after.length ? Math.max(...after.map(v => v.excess)) : 0;
      results[slope] = { baseline: baseline.length, after: after.length, worstExcess };
      // eslint-disable-next-line no-console
      console.log(
        `[developed street] slope=${slope} baseline=${baseline.length} afterHouses=${after.length} ` +
        `worstExcess=${worstExcess.toFixed(3)}`,
      );
    }
    expect(results[0.6].after).toBe(0);
    expect(results[1.0].after).toBe(0);
    expect(results[1.5].after).toBe(0);
  });

  it('PROVE: a demolished-then-rebuilt road is still protected under its NEW easement (no stale/orphaned clamp)', () => {
    // Guards the unregister/re-register lifecycle: demolishing a graded+ road must drop its old
    // easement (Heightfield.unregisterRoadEasement, wired to RoadGraph's `roads:edgeRemoved`), and
    // rebuilding fresh across the same ground must register a new one — not silently leave the
    // corridor unprotected because "this edgeId already had an easement once."
    const { queue, hf, graph, edgeId } = setupAxisAligned(0.8, 64);
    run(queue, 120);
    expect(graph.edges.get(edgeId)!.stage).toBe('painted');

    queue.enqueueDemolish(edgeId);
    run(queue, 120);
    expect(graph.edges.has(edgeId)).toBe(false);

    const [newEdgeId] = graph.commitChain([{ x: -32, z: 0 }, { x: 32, z: 0 }]);
    run(queue, 120);
    const edge = graph.edges.get(newEdgeId)!;
    expect(edge.stage).toBe('painted');

    const midT = edge.length / 2;
    const { pos, heading } = sampleAt(edge.samples, midT);
    const perpX = -Math.sin(heading);
    const perpZ = Math.cos(heading);
    const houseX = pos.x + perpX * SETBACK_MIN;
    const houseZ = pos.z + perpZ * SETBACK_MIN;
    hf.flattenCircle(houseX, houseZ, hf.heightAt(houseX, houseZ), FLATTEN_RADIUS);

    const violations = scanRibbonFootprint(hf, edge.samples, edge.length, 0.06 - 0.02);
    expect(violations.length).toBe(0);
  });

  it('PROVE: the quarry pad (a second, independent post-grading deformer) is also covered by the same easement mechanism', () => {
    // Per the brief's audit requirement: `ConstructionRenderer.placeQuarryProp` (Task 34) calls
    // `hf.flattenCircle(placement.x, placement.z, y, QUARRY_PAD_FLATTEN_RADIUS=13)` — render-side,
    // same structural risk as the house pad, just a larger radius. A quarry is placed >=40u from
    // the FIRST edge that triggers it, but nothing stops a DIFFERENT road being built later close
    // enough for the 13u pad to reach its corridor. This proves the registerRoadEasement mechanism
    // added for houses protects this deformer too, with NO quarry-specific code — "safe by
    // default," the whole point of putting the fix in Heightfield.flattenCircle's one chokepoint
    // rather than teaching each deformer about roads individually.
    const QUARRY_PAD_FLATTEN_RADIUS = 13; // must match constructionRenderer.ts's own constant
    const { queue, hf, graph, edgeId } = setupAxisAligned(0.7, 64);
    run(queue, 120);
    const edge = graph.edges.get(edgeId)!;
    expect(edge.stage).toBe('painted');
    const baseline = scanRibbonFootprint(hf, edge.samples, edge.length, 0.06 - 0.02);
    expect(baseline.length).toBe(0);

    // Place the quarry pad close enough that its 13u flatten radius reaches into the corridor —
    // e.g. a second road built near an already-sited quarry, or the quarry siting search landing
    // nearer to this edge than the 40u rule applied only to the edge that originally triggered it.
    const midT = edge.length / 2;
    const { pos, heading } = sampleAt(edge.samples, midT);
    const perpX = -Math.sin(heading);
    const perpZ = Math.cos(heading);
    const quarryDist = 12; // inside the 13u pad radius from the centerline — deliberately intrusive
    const qx = pos.x + perpX * quarryDist;
    const qz = pos.z + perpZ * quarryDist;
    const qy = hf.heightAt(qx, qz);
    hf.flattenCircle(qx, qz, qy, QUARRY_PAD_FLATTEN_RADIUS);

    const violations = scanRibbonFootprint(hf, edge.samples, edge.length, 0.06 - 0.02);
    // eslint-disable-next-line no-console
    console.log(`[quarry pad] violations=${violations.length}`);
    expect(violations.length).toBe(0);
  });

  it('PROVE: a road split by a later T-junction keeps easement protection under the NEW edge ids', () => {
    // Gap found during root-cause analysis: `RoadGraph.splitEdge` replaces one edge with two new
    // ones (new edge ids), inheriting the ORIGINAL edge's stage directly — so a split-off half of
    // an already-`painted` road never re-runs grading and never re-fires `finalizeGrading` (which
    // is where a fresh edge normally registers its easement). Without an explicit fix, splitting a
    // hillside road at a T-junction would silently drop corridor protection for that stretch
    // forever — right where a new junction/house is most likely to appear next. Fixed via
    // `BuildQueue`'s `roads:edgeAdded` handler explicitly registering an easement for any
    // split-off half born already at >= 'graded'.
    const bus = new EventBus();
    const hf = new Heightfield('split-test', bus);
    setLinearRampZ(hf, 0.6, 10);
    const graph = new RoadGraph(bus, makeSampler(hf));
    const queue = new BuildQueue(graph, hf, bus);

    // 3-point chain so there's a real interior control point (at x=0) to split at later.
    const [edgeId] = graph.commitChain([{ x: -32, z: 0 }, { x: 0, z: 0 }, { x: 32, z: 0 }]);
    run(queue, 120);
    expect(graph.edges.get(edgeId)!.stage).toBe('painted');

    // A second road touches the first's interior control point (x=0, z=0) — RoadGraph.addNode
    // resolves that to `splitEdge`, replacing `edgeId` with two new edges.
    graph.commitChain([{ x: 0, z: 0 }, { x: 0, z: 32 }]);
    expect(graph.edges.has(edgeId)).toBe(false); // original id replaced, per graph.test.ts's own finding

    // Find the split-off half lying along z=0 (the original road, not the new branch) — it should
    // already be 'painted' (inherited stage) and it's the one whose easement matters here.
    const halfOnOriginalRoad = [...graph.edges.values()]
      .find((e) => e.id !== edgeId && e.samples.every((s) => Math.abs(s.z) < 0.5) && e.stage === 'painted');
    expect(halfOnOriginalRoad).toBeDefined();
    const half = halfOnOriginalRoad!;
    run(queue, 5); // let BuildQueue's roads:edgeAdded handler + any resume no-op settle

    // Place a house pad right against this split-off half, exactly like the other PROVE tests.
    const midT = half.length / 2;
    const { pos, heading } = sampleAt(half.samples, midT);
    const perpX = -Math.sin(heading);
    const perpZ = Math.cos(heading);
    const houseX = pos.x + perpX * SETBACK_MIN;
    const houseZ = pos.z + perpZ * SETBACK_MIN;
    hf.flattenCircle(houseX, houseZ, hf.heightAt(houseX, houseZ), FLATTEN_RADIUS);

    const violations = scanRibbonFootprint(hf, half.samples, half.length, 0.06 - 0.02);
    expect(violations.length).toBe(0);
  });

  it('PROVE: a reloaded save stays clean even though SceneryRenderer.rebuild() re-flattens house pads AFTER restoreWorld', () => {
    // This is the literal "third occurrence, after v2" scenario: main.ts calls restoreWorld(...)
    // then sceneryRenderer.rebuild(growth.spawned, ...) right after (see main.ts's boot sequence) —
    // rebuild() re-runs `place()` for every restored house/building record, which calls the same
    // flattenCircle pad-carve a live spawn does. Before this fix, restoreWorld's own clampBelow
    // sweep (which runs BEFORE rebuild) would already be undone by the time the player sees the
    // reloaded world. Proves restoreWorld's new registerRoadEasement call protects against a
    // deform that happens strictly AFTER restoreWorld returns.
    const bus = new EventBus();
    const hf = new Heightfield('restore-test', bus);
    setLinearRampZ(hf, 0.6, 10);
    const graph = new RoadGraph(bus, makeSampler(hf));
    const growth = new GrowthSim(graph, hf, bus, createRng('restore-test'));

    const half = 32;
    const save: SaveV3 = {
      version: 3,
      seed: 'restore-test',
      timeOfDay: 0.5,
      edges: [{ ctrl: [{ x: -half, z: 0 }, { x: half, z: 0 }], stage: 'painted' }],
      growth: { dev: new Array(GRID_SIZE * GRID_SIZE).fill(0), spawned: [], decay: [] },
      quarry: null,
    };
    restoreWorld(save, { bus, hf, graph, growth });

    const edge = [...graph.edges.values()][0];
    expect(edge.stage).toBe('painted');
    const baseline = scanRibbonFootprint(hf, edge.samples, edge.length, 0.06 - 0.02);
    expect(baseline.length).toBe(0); // restoreWorld's own clampBelow sweep already holds here

    // Simulate SceneryRenderer.rebuild() re-flattening a restored house's pad — the exact call
    // sceneryRenderer.ts's place() makes, run AFTER restoreWorld returns (matching main.ts's order).
    const midT = edge.length / 2;
    const { pos, heading } = sampleAt(edge.samples, midT);
    const perpX = -Math.sin(heading);
    const perpZ = Math.cos(heading);
    const houseX = pos.x + perpX * SETBACK_MIN;
    const houseZ = pos.z + perpZ * SETBACK_MIN;
    hf.flattenCircle(houseX, houseZ, hf.heightAt(houseX, houseZ), FLATTEN_RADIUS);

    const violations = scanRibbonFootprint(hf, edge.samples, edge.length, 0.06 - 0.02);
    expect(violations.length).toBe(0);
  });
});
