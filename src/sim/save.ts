import type { P2, Stage } from '../core/types';
import { STAGES } from '../core/types';
import { ROAD_WIDTH } from '../core/constants';
import { RoadGraph } from './roads/graph';
import { Heightfield } from './terrain/heightfield';
import { GrowthSim, type SpawnRecord, type DecayEntry } from './growth/growth';
import {
  BuildQueue,
  CLAMP_FLAT_RADIUS,
  CLAMP_OUTER_RADIUS,
  CLAMP_ALONG_FLAT_RADIUS,
  CLAMP_ALONG_RADIUS,
} from './construction/queue';
import { sampleHeadingAt } from './roads/path';
import { EventBus } from '../core/events';
import { QuarrySim, placeQuarry, type QuarryPlacement } from './quarry';

const SAVE_VERSION = 3 as const;

export interface SaveV1 {
  version: 1;
  seed: string;
  timeOfDay: number;
  edges: { ctrl: P2[]; stage: Stage }[];
  growth: { dev: number[]; spawned: SpawnRecord[] };
  // Deliberately NOT here: ambient wilderness (Task 31, src/sim/growth/wilderness.ts) — it's
  // derived worldgen state regenerated deterministically from `seed` on every boot, and its
  // cleared-by-construction subset re-derives from the restored road graph's replayed
  // `construction:stage` events, so it needs no save slot at all.
}

/**
 * v2 (Task 34): additive `quarry` field — the one-per-island landmark's placement, or `null` if no
 * road has ever been committed in this world (so no quarry has been placed yet). A v1 save (no
 * `quarry` field at all) migrates forward in `deserialize`: since v1 predates the quarry, its
 * absence there just means "not yet computed from this save's data" rather than "no quarry" — the
 * migration path re-derives it deterministically from the same placement function `restoreWorld`
 * would otherwise use live, so an old save gets a quarry exactly where a fresh world with the same
 * seed + same first road would have gotten one.
 */
export interface SaveV2 {
  version: 2;
  seed: string;
  timeOfDay: number;
  edges: { ctrl: P2[]; stage: Stage }[];
  growth: { dev: number[]; spawned: SpawnRecord[] };
  quarry: QuarryPlacement | null;
}

/**
 * v3 (Task 35, extended by the Task 35 follow-up "Groundwork"): `growth.spawned` records always
 * carry a stable `id` (SpawnRecord.id became non-optional once upgrades/stranded-decay needed a
 * way to reference a specific record across events). v1/v2 saves predate ids entirely; migrating
 * them forward assigns sequential ids in array order (deterministic given the same saved array),
 * which is exactly what `GrowthSim.restore` would also do defensively if handed id-less records
 * directly — this migration just does it explicitly and earlier, at the save layer, so `AnySave`
 * callers can rely on every record having a real id straight out of `deserialize`.
 *
 * Groundwork Finding 2 (additive within this same v3 shape — this save format shipped only in
 * local commits, never deployed, so no version bump is needed for this addition; see this task's
 * instructions): `growth.decay` persists any record currently mid-grace or mid-fade as a
 * sim-time-relative offset (`DecayEntry`, see growth.ts) so a save taken mid-decay reloads with its
 * timeline CONTINUING rather than restarting — without this, a record 59s into its 60s grace would
 * reload with a full fresh 60s grace, and a record mid-fade would pop back to full scale/height
 * with its fade animation restarted from 0. Absent/empty for a save with no in-flight timers at
 * save time (the common case) and always empty for a migrated v1/v2 save (predates this state
 * entirely — `deserialize` fills it in as `[]`, matching "nothing was mid-decay").
 */
export interface SaveV3 {
  version: 3;
  seed: string;
  timeOfDay: number;
  edges: { ctrl: P2[]; stage: Stage }[];
  growth: { dev: number[]; spawned: SpawnRecord[]; decay: DecayEntry[] };
  quarry: QuarryPlacement | null;
}

export type AnySave = SaveV3;

/** Minimal shape `serialize` needs from the live world. */
interface SerializableWorld {
  seed: string;
  timeOfDay: number;
  graph: RoadGraph;
  growth: GrowthSim;
  quarry: QuarrySim;
}

export function serialize(world: SerializableWorld): string {
  const save: SaveV3 = {
    version: SAVE_VERSION,
    seed: world.seed,
    timeOfDay: world.timeOfDay,
    edges: [...world.graph.edges.values()].map((e) => ({ ctrl: e.ctrl, stage: e.stage })),
    growth: {
      // Quantize to 3 decimals: dev is a smooth 0..1 accumulator, so this keeps save strings
      // compact without any perceptible loss of fidelity when it's restored.
      dev: world.growth.devLevels.map((v) => Math.round(v * 1000) / 1000),
      spawned: world.growth.spawned.slice(),
      // Finding 2 (Groundwork): in-flight grace/fade timers, as sim-time-relative offsets (see
      // GrowthSim.decayState / DecayEntry's doc comments) — empty when nothing is mid-decay.
      decay: world.growth.decayState.map((d) => ({
        id: d.id,
        ...(d.stranded !== undefined ? { stranded: Math.round(d.stranded * 1000) / 1000 } : {}),
        ...(d.fading !== undefined ? { fading: Math.round(d.fading * 1000) / 1000 } : {}),
      })),
    },
    quarry: world.quarry.placement,
  };
  return JSON.stringify(save);
}

/** Assigns sequential ids (1-based, array order) to any records missing one — used by the v1/v2 ->
 * v3 migration path. Deterministic given the same input array; already-present ids (shouldn't occur
 * pre-v3, but handled defensively) are left untouched and never collided with. */
function assignIds(spawned: SpawnRecord[]): SpawnRecord[] {
  let next = 1;
  for (const r of spawned) {
    if (typeof r.id === 'number' && Number.isFinite(r.id) && r.id >= next) next = r.id + 1;
  }
  return spawned.map((r) => {
    if (typeof r.id === 'number' && Number.isFinite(r.id)) return r;
    return { ...r, id: next++ };
  });
}

function validateEdges(edges: unknown): edges is { ctrl: P2[]; stage: Stage }[] {
  if (!Array.isArray(edges)) return false;
  for (const e of edges) {
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
      return false;
    }
  }
  return true;
}

function validQuarry(q: unknown): q is QuarryPlacement | null {
  if (q === null) return true;
  if (typeof q !== 'object') return false;
  const p = q as Partial<QuarryPlacement>;
  return (
    typeof p.x === 'number' && Number.isFinite(p.x) &&
    typeof p.z === 'number' && Number.isFinite(p.z) &&
    typeof p.rot === 'number' && Number.isFinite(p.rot)
  );
}

/** Finding 2 (Groundwork): validates a `growth.decay` array — each entry needs a finite `id` and
 * exactly a finite `stranded` XOR a finite `fading` offset (never both, never neither — mirrors
 * `DecayEntry`'s own "exactly one of stranded/fading" invariant; a corrupt/hand-edited save
 * violating this is rejected outright like any other malformed field, rather than silently
 * dropping the ambiguous half). `undefined` (the whole `decay` key missing, e.g. a v1/v2 migrated
 * save that predates it) is accepted as "no decay state" — validated/defaulted separately in
 * `deserialize`. */
function validDecay(decay: unknown): decay is DecayEntry[] {
  if (!Array.isArray(decay)) return false;
  for (const d of decay) {
    if (typeof d !== 'object' || d === null) return false;
    const e = d as Partial<DecayEntry>;
    if (typeof e.id !== 'number' || !Number.isFinite(e.id)) return false;
    const hasStranded = typeof e.stranded === 'number' && Number.isFinite(e.stranded);
    const hasFading = typeof e.fading === 'number' && Number.isFinite(e.fading);
    if (hasStranded === hasFading) return false; // exactly one of the two must be present
  }
  return true;
}

/** Loosely-typed shape covering v1/v2/v3 on-disk saves, used only inside `deserialize` before the
 * version-specific validation/migration below settles on a real `SaveV3`. */
interface RawSaveShape {
  version?: unknown;
  seed?: unknown;
  timeOfDay?: unknown;
  edges?: unknown;
  growth?: { dev?: unknown; spawned?: unknown; decay?: unknown };
  quarry?: unknown;
}

/**
 * Returns `null` on parse error or unrecognized version — caller should start a fresh world.
 * Migrations chain forward one step at a time so each step only has to reason about its own
 * predecessor's shape, mirroring the SaveV1 -> SaveV2 -> SaveV3 doc comments above:
 *   v1 -> v2: fills in `quarry: undefined` (deferred to `restoreWorld`, which has the Heightfield +
 *             first edge's samples needed to actually compute a placement) — this function's job
 *             is just to accept the older shape rather than reject it outright.
 *   v2 -> v3: assigns sequential ids (via `assignIds`) to every `growth.spawned` record, since v2
 *             predates SpawnRecord.id entirely.
 * A v1 save therefore falls through both steps to reach v3 in one `deserialize` call.
 */
export function deserialize(json: string): SaveV3 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as RawSaveShape;
  if (p.version !== 1 && p.version !== 2 && p.version !== 3) return null;

  if (
    typeof p.seed !== 'string' ||
    typeof p.timeOfDay !== 'number' ||
    !Number.isFinite(p.timeOfDay) || // Minor 9: reject NaN/Infinity, not just "is a number"
    !validateEdges(p.edges) ||
    !p.growth ||
    !Array.isArray(p.growth.dev) ||
    !Array.isArray(p.growth.spawned)
  ) {
    return null;
  }
  const dev = p.growth.dev as number[];
  const rawSpawned = p.growth.spawned as SpawnRecord[];

  // Step 1: v1 -> v2 (quarry field). v2 and v3 both require a valid `quarry` key; v1 has none at
  // all, which migrates to the `undefined` sentinel (see this function's doc comment above).
  let quarry: QuarryPlacement | null | undefined;
  if (p.version === 1) {
    quarry = undefined as unknown as QuarryPlacement | null;
  } else {
    if (!('quarry' in p) || !validQuarry(p.quarry)) return null;
    quarry = p.quarry as QuarryPlacement | null;
  }

  // Step 2: v2 -> v3 (record ids). v3 saves already have ids on every record (round-tripped via
  // `serialize`); v1/v2 saves have none, so `assignIds` backfills them deterministically. Calling
  // it unconditionally on an already-v3 save is a harmless no-op (every record already has an id).
  const spawned = assignIds(rawSpawned);

  // Step 3 (Groundwork Finding 2): `growth.decay` — additive within v3 (this save format never
  // shipped, so no version bump was needed for this addition; see this task's instructions). A
  // v1/v2 save (or any v3 save predating this field) simply has no key here at all: that migrates
  // to `[]` ("nothing was mid-decay"), exactly matching a real save taken while nothing happened to
  // be stranded. A `decay` key that IS present but fails validation (malformed/corrupt) rejects the
  // whole save, consistent with every other field's handling above.
  let decay: DecayEntry[];
  if (!('decay' in p.growth) || p.growth.decay === undefined) {
    decay = [];
  } else {
    if (!validDecay(p.growth.decay)) return null;
    decay = p.growth.decay;
  }

  return {
    version: 3,
    seed: p.seed,
    timeOfDay: p.timeOfDay,
    edges: p.edges,
    growth: { dev, spawned, decay },
    quarry: quarry as QuarryPlacement | null,
  };
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
  /**
   * Optional: the live QuarrySim, if one exists (mirrors `queue?` above). When present, the saved
   * placement (if any) is fed back in via `restore()` BEFORE any edges are re-committed below — this
   * disarms QuarrySim's own `roads:edgeAdded` listener so the replayed first edge doesn't trigger a
   * second, redundant auto-placement/`quarry:placed` emit. If the save predates Task 34 (v1
   * migrated forward, `save.quarry === undefined`) and at least one road exists, a placement is
   * computed here from the restored graph's very first edge — same deterministic function a live
   * first-road commit would have used — so an old save gets a quarry exactly where a fresh world
   * with the same seed + same first road would.
   */
  quarry?: QuarrySim;
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
export function restoreWorld(save: SaveV3, deps: RestoreDeps): void {
  const { bus, hf, graph, growth, queue, quarry } = deps;
  const gradeRadius = ROAD_WIDTH / 2;
  const offset = ROAD_WIDTH / 2 - 0.8;

  // Feed back an already-known placement BEFORE any edges are re-committed (see quarry?'s doc
  // comment above) so QuarrySim's own listener is disarmed ahead of the replay.
  if (quarry && save.quarry) quarry.restore(save.quarry);

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
    // yet at this point in main.ts's boot sequence. `crew: -1` — this is a synthetic sync event, not
    // a real crew's work (the actual resuming crew, if any, is assigned below by `enqueueResume`).
    bus.emit('construction:stage', { edgeId, stage: saved.stage, crew: -1 });

    // Finding 1: forcing `edge.stage` above freezes construction forever unless the crew is
    // told to pick back up where the save left off — resume a build job starting at the stage
    // after the restored one (no-op for an already-`painted` edge).
    queue?.enqueueResume(edgeId);

    if (STAGES.indexOf(saved.stage) >= STAGES.indexOf('graded')) {
      for (let i = 0; i < edge.samples.length; i++) {
        const s = edge.samples[i];
        if (s.bridge) continue;
        const heading = sampleHeadingAt(edge.samples, i);
        const perpX = -Math.sin(heading);
        const perpZ = Math.cos(heading);
        hf.flattenCircle(s.x, s.z, s.y, gradeRadius);
        hf.flattenCircle(s.x + perpX * offset, s.z + perpZ * offset, s.y, gradeRadius);
        hf.flattenCircle(s.x - perpX * offset, s.z - perpZ * offset, s.y, gradeRadius);
      }
      // Playtest fix ("land still rendering above the cleared road"): flattenCircle shapes the
      // embankment via a blended smoothstep pull, but can still leave terrain above the roadbed
      // on cross-slopes. Follow with a hard clampBelow pass (mirrors BuildQueue's graded-complete
      // finalization, Task 24 revision: an anisotropic hard no-allowance flat zone — generous
      // across the corridor via CLAMP_FLAT_RADIUS/CLAMP_OUTER_RADIUS, narrow along the road's own
      // arclength via CLAMP_ALONG_FLAT_RADIUS/CLAMP_ALONG_RADIUS so it can't reach a neighboring
      // sample with a meaningfully different target elevation on hilly terrain — so a reloaded
      // save is guaranteed to have no terrain poking through the cut, not just an
      // approximately-flattened embankment.
      for (let i = 0; i < edge.samples.length; i++) {
        const s = edge.samples[i];
        if (s.bridge) continue;
        const heading = sampleHeadingAt(edge.samples, i);
        hf.clampBelow(s.x, s.z, s.y, CLAMP_OUTER_RADIUS, CLAMP_FLAT_RADIUS, heading, CLAMP_ALONG_RADIUS, CLAMP_ALONG_FLAT_RADIUS);
      }
    }
  }

  growth.restore(save.growth.dev, save.growth.spawned, save.growth.decay);

  // v1-migration case (Task 34): `save.quarry === undefined` means this save predates the quarry
  // feature entirely (deserialize's migration path leaves it unset, distinct from an explicit
  // `null`, which means "v2 save, but no road had been committed yet"). If at least one road now
  // exists in the restored graph, place a quarry the same deterministic way a live first-road
  // commit would have: using the FIRST edge in restoration order and this world's own seed. A save
  // with zero edges simply has nothing to anchor a placement to yet — QuarrySim's still-armed
  // `roads:edgeAdded` listener will place one normally whenever the player draws their first road.
  if (quarry && save.quarry === undefined && !quarry.placement) {
    const [firstEdge] = graph.edges.values();
    if (firstEdge) {
      const placement = placeQuarry(hf, firstEdge.samples, save.seed);
      if (placement) {
        quarry.restore(placement);
        bus.emit('quarry:placed', placement);
      }
    }
  }

  // Final emit after all stages are forced: `commitChain` already fired `roads:changed` per edge,
  // but at that point each edge was still 'surveyed' (stage is forced afterward above), so growth's
  // road-distance BFS — which only seeds from 'painted' edges — would have seen nothing. Emitting
  // once more now, with every edge at its restored stage, gives growth's next `update()` a correct
  // recompute.
  bus.emit('roads:changed', {});
}
