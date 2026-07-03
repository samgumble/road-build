import { describe, it, expect } from 'vitest';
import { BuildQueue } from '../src/sim/construction/queue';
import { RoadGraph } from '../src/sim/roads/graph';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { makeSampler, sampleAt } from '../src/sim/roads/path';
import { EventBus } from '../src/core/events';
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
  });

  it('REPRODUCE(axis-aligned): no terrain pokes above the road once fully built', () => {
    const { queue, hf, graph, edgeId } = setupAxisAligned(0.6, 64);
    run(queue, 120); // full build through painted
    const edge = graph.edges.get(edgeId)!;
    expect(edge.stage).toBe('painted');
    const violations = scanRibbonFootprint(hf, edge.samples, edge.length, 0.06 - 0.02);
    expect(violations.length).toBe(0);
  });

  it('REPRODUCE(axis-aligned): steeper slope (1.0) still holds after full build', () => {
    const { queue, hf, graph, edgeId } = setupAxisAligned(1.0, 64);
    run(queue, 120);
    const edge = graph.edges.get(edgeId)!;
    const violations = scanRibbonFootprint(hf, edge.samples, edge.length, 0.06 - 0.02);
    expect(violations.length).toBe(0);
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
  });

  it('REPRODUCE(diagonal, gentle slope): no terrain pokes above the road mid-construction', () => {
    const { queue, hf, graph, edgeId } = setupDiagonal(0.3, 64);
    runIntoGrading(queue, 64, 3);
    const edge = graph.edges.get(edgeId)!;
    const violations = scanRibbonFootprint(hf, edge.samples, edge.length, 0.06 - 0.02);
    const workFrontT = 3 * GRADE_SPEED;
    const behindFront = violations.filter((v) => v.t < workFrontT - CELL * 2);
    expect(behindFront.length).toBe(0);
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
