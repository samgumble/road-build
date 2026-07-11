import type { Stage, V3, VehicleKind } from './types';

export interface GameEvents {
  'roads:changed': Record<string, never>;                     // any topology/stage change relevant to lanes+growth
  'roads:edgeAdded': { edgeId: number };
  'roads:edgeRemoved': { edgeId: number };
  'construction:stage': { edgeId: number; stage: Stage | 'removed'; crew: number };
  // `onBreak` (Task 33, additive): true while this crew is on its periodic work-rhythm break —
  // `t`/pos are stationary (frozen) for the break's duration; renderers can react (workers huddle
  // near the stockpile, vehicles idle) via this flag rather than inferring it from a lack of
  // position change.
  'construction:progress': { edgeId: number; stage: Stage; t: number; pos: V3; heading: number; vehicle: VehicleKind; demolish: boolean; crew: number; onBreak: boolean };
  // Presentation-facing traffic lifecycle: emitted once when a car spawns onto or transitions
  // into a different road edge. `firstUse` is true exactly once for a road that was painted by a
  // live crew (restore replay uses crew=-1 and deliberately does not arm a ceremony).
  'traffic:edgeEntered': { edgeId: number; carId: number; pos: V3; firstUse: boolean };
  'terrain:deformed': { minI: number; minJ: number; maxI: number; maxJ: number };
  // `id` (Task 35, additive): stable per-record id, monotonic within a GrowthSim instance and
  // persisted in saves — lets upgrade/stranded-decay events (below) reference a specific record
  // without relying on array position. Optional so pre-Task-35 callers/tests that construct this
  // payload by hand still type-check; consumers should treat a missing id defensively.
  'growth:spawn': { kind: 'tree' | 'field' | 'house' | 'building'; x: number; z: number; rot: number; id?: number };
  // Task 35: a house record upgraded in place to a building (same id, cell dev >= 1.35 with >= 2
  // developed neighbor cells). Renderer swaps the house instance for a building instance with a
  // pop animation; houseCount decrements. Fires at most once per record.
  'growth:upgrade': { id: number };
  // Task 35: a record has crossed the stranded-decay grace period (60 sim-s > 24u from any painted
  // road) and begins its ~30s fade-out. Additive — renderer starts the ease-down/sink animation;
  // the record is NOT removed yet (see `growth:remove` below, fired when the fade completes).
  'growth:stranded': { id: number };
  // Task 35: a stranded record's fade completed — the sim has deleted it from `GrowthSim.spawned`
  // and cleared the owning cell's spawnMask bits (regrowth becomes possible once re-roaded).
  // Renderer frees the instance slot; houseCount already decremented sim-side for house records.
  'growth:remove': { id: number };
  // Critical 3 (Groundwork round fix wave, additive): a record that was stranded (mid-grace OR
  // mid-fade) became safe again — re-roaded before `growth:remove` ever fired. `updateStrandedDecay`
  // cancels its own internal timers silently in this case (always did), but previously emitted
  // NOTHING, so a renderer-side Fading entry already in flight (started by `growth:stranded`) had no
  // way to know the sim gave up on removing it — it just kept easing to scale~0 and sat there
  // forever once its local timer ran out, with no sim event ever arriving to free/reset it. Fired
  // for BOTH directions of rescue: re-roaded during the grace window (renderer never even started a
  // fade — a harmless no-op there) and re-roaded mid-fade (renderer must ease the instance back to
  // full scale, not snap). See sceneryRenderer.ts's `onRescued`.
  'growth:rescued': { id: number };
  // Task 42 ("Groundwork"): a road's build corridor reached (or was restored at/past) 'graded' and
  // this record sits within it — begins a QUICK clearing fade (GrowthSim's CLEAR_FADE_S, ~1.5s,
  // matching wilderness.ts's WILDERNESS_FADE_DURATION feel), distinct from `growth:stranded`'s much
  // slower decay fade: the renderer must use its own short duration for this event rather than
  // STRANDED_FADE_DURATION. Applies to every GrowthKind (tree/field/house/building) — the survey
  // preview shows exactly where the road goes, so anything in that footprint is demolished, not
  // just trees. `growth:remove` (already existing, additive to no consumer) still fires once the
  // fade completes, same as stranded decay's own removal — NOT rescuable: `growth:rescued` is never
  // emitted for a record cleared this way, even if the road that cleared it is later demolished.
  'growth:cleared': { id: number };
  'atmosphere:phase': { night: boolean };
  // Task 31: ambient wilderness clearing. `indices` are positions into the WildernessTree[] array
  // the renderer/sim were both constructed with (stable per tree for the life of the world).
  'wilderness:cleared': { indices: number[] };
  // Task 34: quarry landmark placed (first road commit ever, or replayed on restore — see
  // src/sim/quarry.ts). Additive event; renderers build the pad+prop in response.
  'quarry:placed': { x: number; z: number; rot: number };
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<string, Set<Handler<never>>>();
  on<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    set.add(fn as Handler<never>);
    return () => set!.delete(fn as Handler<never>);
  }
  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    this.handlers.get(type)?.forEach((fn) => (fn as Handler<GameEvents[K]>)(payload));
  }
}
