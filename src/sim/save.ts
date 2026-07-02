import type { P2, Stage } from '../core/types';
import { STAGES } from '../core/types';
import { ROAD_WIDTH } from '../core/constants';
import { RoadGraph } from './roads/graph';
import { Heightfield } from './terrain/heightfield';
import { GrowthSim, type SpawnRecord } from './growth/growth';
import { BuildQueue } from './construction/queue';
import { EventBus } from '../core/events';

const SAVE_VERSION = 1 as const;

export interface SaveV1 {
  version: 1;
  seed: string;
  timeOfDay: number;
  edges: { ctrl: P2[]; stage: Stage }[];
  growth: { dev: number[]; spawned: SpawnRecord[] };
}

/** Minimal shape `serialize` needs from the live world. */
interface SerializableWorld {
  seed: string;
  timeOfDay: number;
  graph: RoadGraph;
  growth: GrowthSim;
}

export function serialize(world: SerializableWorld): string {
  const save: SaveV1 = {
    version: SAVE_VERSION,
    seed: world.seed,
    timeOfDay: world.timeOfDay,
    edges: [...world.graph.edges.values()].map((e) => ({ ctrl: e.ctrl, stage: e.stage })),
    growth: {
      // Quantize to 3 decimals: dev is a smooth 0..1 accumulator, so this keeps save strings
      // compact without any perceptible loss of fidelity when it's restored.
      dev: world.growth.devLevels.map((v) => Math.round(v * 1000) / 1000),
      spawned: world.growth.spawned.slice(),
    },
  };
  return JSON.stringify(save);
}

/** Returns `null` on parse error or version mismatch — caller should start a fresh world. */
export function deserialize(json: string): SaveV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== SAVE_VERSION
  ) {
    return null;
  }
  const p = parsed as Partial<SaveV1>;
  if (
    typeof p.seed !== 'string' ||
    typeof p.timeOfDay !== 'number' ||
    !Number.isFinite(p.timeOfDay) || // Minor 9: reject NaN/Infinity, not just "is a number"
    !Array.isArray(p.edges) ||
    !p.growth ||
    !Array.isArray(p.growth.dev) ||
    !Array.isArray(p.growth.spawned)
  ) {
    return null;
  }
  for (const e of p.edges) {
    if (
      typeof e !== 'object' ||
      e === null ||
      !Array.isArray((e as { ctrl?: unknown }).ctrl) ||
      !(e as { ctrl: unknown[] }).ctrl.every(
        (c) =>
          typeof c === 'object' &&
          c !== null &&
          typeof (c as P2).x === 'number' &&
          typeof (c as P2).z === 'number' &&
          Number.isFinite((c as P2).x) && // Minor 9: reject NaN/Infinity control points, which
          Number.isFinite((c as P2).z), // would otherwise poison the sampler/heightfield downstream
      ) ||
      !STAGES.includes((e as { stage?: unknown }).stage as Stage)
    ) {
      return null;
    }
  }
  return p as SaveV1;
}

/** Minimal shape `restoreWorld` needs from the live world it's restoring into. */
interface RestoreDeps {
  bus: EventBus;
  hf: Heightfield;
  graph: RoadGraph;
  growth: GrowthSim;
  /**
   * Optional: the live BuildQueue, if one exists (main.ts wiring has one; the save.test.ts
   * `freshWorld` helper doesn't). When present, any job auto-enqueued by `commitChain`'s
   * `roads:edgeAdded` for a restored edge is discarded via `clearPending` — the edge's stage is
   * forced directly below rather than rebuilt by the crew.
   */
  queue?: BuildQueue;
}

/**
 * Rebuilds a world in-place from a save: commits each edge's control chain (so the graph, road
 * renderer, and lane/traffic sampling all pick it up normally), then forces the edge's stage to
 * match the save. For any edge at stage >= 'graded', immediately re-flattens the terrain along its
 * non-bridge samples (centerline + the two perpendicular offsets used at build time — see
 * `BuildQueue.update`'s grading pass in `src/sim/construction/queue.ts`) so reloading doesn't leave
 * ungraded terrain under an already-built road. Finally restores growth state and emits
 * `roads:changed` once so downstream systems (lane markings, growth road-distance field) recompute.
 */
export function restoreWorld(save: SaveV1, deps: RestoreDeps): void {
  const { bus, hf, graph, growth, queue } = deps;
  const gradeRadius = ROAD_WIDTH / 2;
  const offset = ROAD_WIDTH / 2 - 0.8;

  for (const saved of save.edges) {
    // DOCUMENTED-SKIP: only the first id returned by `commitChain` is used below. A normal save
    // never produces a chain that itself gets split into multiple edges on restore (each saved
    // edge's `ctrl` is exactly one already-committed edge's control chain, and interior points
    // don't re-trigger a split against a graph that's being rebuilt in the same order they were
    // originally created), but a hand-crafted/corrupted save whose `ctrl` deliberately crosses an
    // already-restored edge could return >1 id here, silently dropping the extra piece(s)'
    // stage-forcing below. Not handling that: it's an edge case only reachable via a malformed
    // save file, not normal play, and the fix would add real complexity for no in-game benefit.
    const [edgeId] = graph.commitChain(saved.ctrl);
    if (edgeId === undefined) continue; // degenerate chain (shouldn't happen for a valid save)

    queue?.clearPending(edgeId);

    const edge = graph.edges.get(edgeId);
    if (!edge) continue;
    edge.stage = saved.stage;

    // Critical 1: `commitChain` above only emitted `construction:stage`-less events (edges start
    // life at 'surveyed', with no stage event of their own), so `RoadRenderer` — which only
    // re-renders a stage's appearance in response to `construction:stage` / `construction:progress`
    // — has no idea the stage was just force-set above and keeps drawing the edge as fresh survey
    // dashes. Emit the event ourselves so the renderer (and anything else listening, e.g. the HUD's
    // ticker) picks up the restored stage immediately. Safe pre-user-gesture: AmbientAudio's
    // `construction:stage` handler no-ops without an AudioContext, and the HUD isn't constructed
    // yet at this point in main.ts's boot sequence.
    bus.emit('construction:stage', { edgeId, stage: saved.stage });

    // Finding 1: forcing `edge.stage` above freezes construction forever unless the crew is
    // told to pick back up where the save left off — resume a build job starting at the stage
    // after the restored one (no-op for an already-`painted` edge).
    queue?.enqueueResume(edgeId);

    if (STAGES.indexOf(saved.stage) >= STAGES.indexOf('graded')) {
      for (const s of edge.samples) {
        if (s.bridge) continue;
        const heading = sampleHeading(edge.samples, s);
        const perpX = -Math.sin(heading);
        const perpZ = Math.cos(heading);
        hf.flattenCircle(s.x, s.z, s.y, gradeRadius);
        hf.flattenCircle(s.x + perpX * offset, s.z + perpZ * offset, s.y, gradeRadius);
        hf.flattenCircle(s.x - perpX * offset, s.z - perpZ * offset, s.y, gradeRadius);
      }
    }
  }

  growth.restore(save.growth.dev, save.growth.spawned);

  // Final emit after all stages are forced: `commitChain` already fired `roads:changed` per edge,
  // but at that point each edge was still 'surveyed' (stage is forced afterward above), so growth's
  // road-distance BFS — which only seeds from 'painted' edges — would have seen nothing. Emitting
  // once more now, with every edge at its restored stage, gives growth's next `update()` a correct
  // recompute.
  bus.emit('roads:changed', {});
}

/** Heading at sample `s`, matching the forward-difference convention used while grading live. */
function sampleHeading(
  samples: { x: number; y: number; z: number; bridge: boolean }[],
  s: { x: number; y: number; z: number; bridge: boolean },
): number {
  const i = samples.indexOf(s);
  const a = samples[Math.max(0, i - 1)];
  const b = samples[Math.min(samples.length - 1, i + 1)];
  return Math.atan2(b.z - a.z, b.x - a.x);
}
