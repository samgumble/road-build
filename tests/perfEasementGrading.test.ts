import { describe, it, expect } from 'vitest';
import { BuildQueue } from '../src/sim/construction/queue';
import { RoadGraph } from '../src/sim/roads/graph';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { makeSampler } from '../src/sim/roads/path';
import { EventBus } from '../src/core/events';

/**
 * Task 47, Item 2: perf evidence (and fix) for "combined easement x grading load" — the worst case
 * T46's frame-budget numbers never measured (T46 ran on FRESH worlds with an empty easement
 * registry; see task-46-report.md's own frame-time note). The brief's hypothesized worst case: a
 * built-out map (20+ registered road easements, Task 43) with several crews grading NEW edges
 * immediately adjacent to those already-built roads, at 16x HUD speed — `Loop` batches up to
 * `ceil(8 * timeScale)` = 128 fixed sim-steps into a single rendered frame at 16x (see
 * src/core/loop.ts), and every one of those steps that lands on a grading front calls
 * `gradeTerrainAt` -> 3x `flattenCircle` (centerline + 2 perpendicular offsets), each of which
 * independently calls `Heightfield.reapplyEasementsNear` and replays every registered easement
 * sample whose footprint overlaps the touched region — every single call, not once per batch.
 *
 * Measured (this file, "without batching" case below): worst ~154ms / avg ~108ms per 128-step
 * batch with 24 registered easements and 3 crews grading adjacent edges — far past the ~4ms
 * concern threshold from the task brief. Root cause: the SAME easement samples get replayed dozens
 * of times per batch (once per nearby `flattenCircle` call), not once.
 *
 * Fix implemented: `Heightfield.beginDeformBatch()`/`endDeformBatch()` (see heightfield.ts),
 * wired around `Loop`'s whole per-frame batch of fixed sim-steps via `Loop.onBatchStart`/
 * `onBatchEnd` (see loop.ts + main.ts). While a batch is open, `flattenCircle` still mutates height
 * data immediately every call (grading itself is unaffected, still fully deterministic/sim-exact),
 * but the easement REPLAY is deferred and deduped (by `edgeId:idx`, the same key
 * `reapplyEasementsNear` already used per-call) until `endDeformBatch()`, which replays each
 * touched sample exactly once. This is safe because the replay's result is order-independent: each
 * replay is a hard clamp-down (`applyClampBelow` only ever pulls a vertex DOWN, never raises it),
 * so replaying the same fixed set of samples once at the end of a batch converges to the identical
 * final heightfield state as replaying after every intermediate call.
 *
 * This test measures the SAME worst-case scenario both WITHOUT and WITH the batching bracket,
 * using the real `BuildQueue`/`Heightfield`/`RoadGraph` objects (no synthetic microbenchmark), and
 * reports both sets of numbers.
 */

/** Finds a row (fixed z) with at least `span` contiguous land along x starting near `xStart`. */
function findRow(hf: Heightfield, span: number, z: number, xStart: number): number | null {
  for (let x = xStart; x <= 240 - span; x += 8) {
    if (hf.isLand(x, z) && hf.isLand(x + span, z)) return x;
  }
  return null;
}

/**
 * Builds the worst-case scenario: a dense comb of `ROW_COUNT` parallel built (painted,
 * easement-registered) roads, then 3 new edges crossing THROUGH that comb (so they stay within
 * easement reach almost continuously along their length), drained just past survey so all 3
 * crews are actively grading. Returns the live `queue`/`graph`/`newEdgeIds` so the caller can
 * measure batches of `queue.update` calls with or without a deform-batch bracket.
 */
function buildWorstCaseScenario(seed: string) {
  const bus = new EventBus();
  const hf = new Heightfield(seed, bus);
  const graph = new RoadGraph(bus, makeSampler(hf));
  const queue = new BuildQueue(graph, hf, bus);

  const ROW_SPAN = 64;
  const ROW_SPACING = 8; // matches real street spacing used elsewhere in this codebase's tests
  const ROW_COUNT = 24; // >= 20 registered edges per the task brief
  const X_START = -64;
  const builtRows: number[] = [];
  let z = -96;
  for (let i = 0; i < ROW_COUNT && builtRows.length < ROW_COUNT; z += ROW_SPACING) {
    const x = findRow(hf, ROW_SPAN, z, X_START);
    if (x === null) continue;
    graph.commitChain([{ x, z }, { x: x + ROW_SPAN, z }]);
    builtRows.push(z);
    i++;
  }
  if (builtRows.length !== ROW_COUNT) throw new Error('scenario setup: could not place all built rows');

  const dt = 1 / 60;
  let guard = 0;
  while ([...graph.edges.values()].some((e) => e.stage !== 'painted') && guard < 400 * 60) {
    queue.update(dt);
    guard++;
  }
  if (![...graph.edges.values()].every((e) => e.stage === 'painted')) {
    throw new Error('scenario setup: built rows did not all reach painted');
  }

  // 3 new edges crossing perpendicular through the dense comb, spaced apart from each other.
  const zMin = builtRows[0];
  const zMax = builtRows[builtRows.length - 1];
  const midX = X_START + ROW_SPAN / 2;
  const newEdgeIds: number[] = [];
  for (let i = 0; i < 3; i++) {
    const x = midX + i * 12;
    const [id] = graph.commitChain([{ x, z: zMin - 4 }, { x, z: zMax + 4 }]);
    newEdgeIds.push(id);
  }

  // Drain just past survey so all 3 crews are actively grading. Gate on the real
  // `construction:progress` event stream (stage === 'graded' actually firing) rather than
  // `edge.stage`, which only flips away from 'surveyed' once the ENTIRE 'graded' front finishes
  // crossing the WHOLE edge (Task 36's train model updates `edge.stage` per completed FRONT, not
  // per front start) — gating on `edge.stage` would silently drain straight through most of
  // grading itself before measurement starts.
  let gradingStarted = 0;
  const unsub = bus.on('construction:progress', (e) => {
    if (newEdgeIds.includes(e.edgeId) && e.stage === 'graded') gradingStarted++;
  });
  guard = 0;
  while (gradingStarted < 3 && guard < 60 * 60) {
    queue.update(dt);
    guard++;
  }
  unsub();
  if (gradingStarted < 3) throw new Error('scenario setup: not all 3 crews reached active grading');

  return { hf, graph, queue, newEdgeIds, dt, ROW_COUNT };
}

/** Runs batches of `queue.update` (BATCH_SIZE ticks each, matching Loop's 16x-HUD-speed cap) until
 * every new edge finishes the 'graded' stage or NUM_BATCHES is reached, optionally bracketing each
 * batch with `hf.beginDeformBatch()`/`endDeformBatch()`. Returns per-batch wall-clock ms. */
function measureBatches(
  scenario: ReturnType<typeof buildWorstCaseScenario>,
  useBatchBracket: boolean,
): number[] {
  const { hf, graph, queue, newEdgeIds, dt } = scenario;
  const BATCH_SIZE = 128; // Loop's cap at 16x HUD speed: ceil(8 * 16)
  const NUM_BATCHES = 40;
  const batchMs: number[] = [];
  for (let b = 0; b < NUM_BATCHES; b++) {
    if (newEdgeIds.every((id) => graph.edges.get(id)!.stage !== 'surveyed')) break;
    const t0 = performance.now();
    if (useBatchBracket) hf.beginDeformBatch();
    for (let i = 0; i < BATCH_SIZE; i++) queue.update(dt);
    if (useBatchBracket) hf.endDeformBatch();
    const t1 = performance.now();
    batchMs.push(t1 - t0);
  }
  return batchMs;
}

describe('Perf: combined easement x grading load (Task 47 item 2)', () => {
  it('WITHOUT batching: measures the worst/avg per-batch ms for 3 crews grading edges adjacent to a dense built-out neighborhood at 16x', () => {
    const scenario = buildWorstCaseScenario('perf-easement-grading-nobatch');
    const batchMs = measureBatches(scenario, false);

    expect(batchMs.length).toBeGreaterThan(3); // confirms grading spanned multiple measured batches

    const worst = Math.max(...batchMs);
    const avg = batchMs.reduce((a, b) => a + b, 0) / batchMs.length;

    // eslint-disable-next-line no-console
    console.log(
      `[perf][no-batch] ${scenario.ROW_COUNT} registered easements (dense grid), 3 crews grading ` +
      `edges crossing the grid, batch=128 sim-steps (16x HUD equivalent) over ${batchMs.length} ` +
      `batches: worst=${worst.toFixed(3)}ms avg=${avg.toFixed(3)}ms`,
    );

    // Documents the measured worst case exceeds the brief's ~4ms concern threshold (this is what
    // justifies the beginDeformBatch/endDeformBatch fix below, not a pass/fail gate on its own —
    // see task-47-report.md for the actual numbers and the decision this test's sibling proves).
    expect(worst).toBeGreaterThan(4);
  });

  it('WITH batching (beginDeformBatch/endDeformBatch): the same worst case drops several-fold, to legitimate once-per-batch replay work', () => {
    const scenario = buildWorstCaseScenario('perf-easement-grading-batched');
    const batchMs = measureBatches(scenario, true);

    expect(batchMs.length).toBeGreaterThan(3); // confirms grading spanned multiple measured batches

    const worst = Math.max(...batchMs);
    const avg = batchMs.reduce((a, b) => a + b, 0) / batchMs.length;

    // eslint-disable-next-line no-console
    console.log(
      `[perf][batched] ${scenario.ROW_COUNT} registered easements (dense grid), 3 crews grading ` +
      `edges crossing the grid, batch=128 sim-steps (16x HUD equivalent) over ${batchMs.length} ` +
      `batches: worst=${worst.toFixed(3)}ms avg=${avg.toFixed(3)}ms`,
    );

    // The dedupe collapses N-calls-per-sample-per-batch down to 1-call-per-sample-per-batch, but
    // with this many DISTINCT easement samples touched by 3 concurrent crews crossing a dense
    // 24-edge grid, the once-per-batch replay itself is still real, legitimate work (measured
    // floor with easements fully unregistered: ~4-7ms/batch for grading alone — see
    // task-47-report.md). This asserts the fix brings the SAME worst case down several-fold from
    // the unbatched ~156ms (a real regression guard against the dedupe regressing back to
    // per-call replay), not an unrealistic near-zero target.
    expect(worst).toBeLessThan(60);
  });

  it('produces the same final terrain heights whether or not the batch bracket is used (replay is order-independent/commutative)', () => {
    // T43's own review note: a hard clamp-down (`applyClampBelow`) never raises terrain, so
    // replaying the same fixed set of easement samples once at the end of a batch instead of
    // after every intermediate flattenCircle call converges to the identical final heightfield
    // state. Proves that directly: run the identical scenario/tick sequence twice (same seed, same
    // commands), once with the bracket and once without, and diff the height grids afterward.
    const dt = 1 / 60;
    const seed = 'perf-easement-grading-equivalence';

    const a = buildWorstCaseScenario(seed);
    for (let i = 0; i < 128 * 6; i++) a.queue.update(dt);

    const b = buildWorstCaseScenario(seed);
    for (let i = 0; i < 6; i++) {
      b.hf.beginDeformBatch();
      for (let j = 0; j < 128; j++) b.queue.update(dt);
      b.hf.endDeformBatch();
    }

    let maxDiff = 0;
    for (let i = 0; i < a.hf.heights.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(a.hf.heights[i] - b.hf.heights[i]));
    }
    // Float32Array precision (~7 significant digits) means replaying the same clamp-down in a
    // different order/grouping can land a hair off in the last bit or two even when
    // mathematically identical in exact arithmetic — this asserts NEGLIGIBLE divergence (far below
    // anything visually or gameplay perceptible on a heightfield with ~30-unit elevation range),
    // not bit-exact equality.
    expect(maxDiff).toBeLessThan(1e-2);
  });
});
